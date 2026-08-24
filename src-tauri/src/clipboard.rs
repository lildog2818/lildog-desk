//! 历史剪贴板小组件后端：轮询读取系统剪贴板、回填文本 / 文件列表。
//!
//! 设计要点：
//! - 前端以 `read_clipboard_state(last_seq)` 轮询，`GetClipboardSequenceNumber`
//!   未变化时直接返回 None（一次轻量系统调用，不开剪贴板）。
//! - 写命令返回写入后的新序列号，前端用它抑制"自己复制导致再次入库"。
//! - 图片仅支持 CF_DIB 的 24/32bpp BI_RGB（覆盖绝大多数截图与复制场景），
//!   解码为 PNG 存到 `<app_data>/clipboard_images/`，其余格式标记为 other 跳过。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::storage;

/// 单条文本入库上限（字符），超出截断并标记 truncated
const MAX_TEXT_CHARS: usize = 20_000;
/// 图片像素总量上限（约 8K x 8K）
const MAX_IMAGE_PIXELS: i64 = 8192i64 * 8192;
/// 单条文件列表上限
const MAX_FILE_ENTRIES: usize = 64;

const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
const CF_BITMAP: u32 = 2;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipPayload {
    pub seq: u64,
    /// "text" | "image" | "files" | "other"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

fn default_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("clipboard_images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 设置里配置的自定义保存目录（未配置返回 None）
fn configured_clip_dir(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = storage::data_dir(app);
    let s = storage::load_settings(&dir);
    match s.clip_dir.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            let pb = PathBuf::from(p);
            std::fs::create_dir_all(&pb).map_err(|e| e.to_string())?;
            Ok(Some(pb))
        }
        _ => Ok(None),
    }
}

/// 当前生效的图片保存目录
pub(crate) fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(d) = configured_clip_dir(app)? {
        return Ok(d);
    }
    default_images_dir(app)
}

/// 把 from 目录下的 PNG 移动到 to；跨卷 rename 失败时降级为复制+删除
fn migrate_pngs(from: &Path, to: &Path) -> Result<(), String> {
    let rd = match std::fs::read_dir(from) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let is_png = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if !is_png {
            continue;
        }
        let dest = to.join(entry.file_name());
        if dest.exists() {
            continue;
        }
        if std::fs::rename(&p, &dest).is_err() {
            std::fs::copy(&p, &dest)
                .map_err(|e| format!("迁移图片失败：{e}"))?;
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}

/// 设置剪贴板图片保存目录；None/空 表示恢复默认位置。
/// 切换时自动把现有 PNG 迁移过去。
#[tauri::command]
pub async fn set_clip_dir(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let target = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            let pb = PathBuf::from(p);
            std::fs::create_dir_all(&pb).map_err(|e| format!("创建目录失败：{e}"))?;
            Some(pb)
        }
        _ => None,
    };
    let current = images_dir(&app)?;
    let dest = match &target {
        Some(d) => d.clone(),
        None => default_images_dir(&app)?,
    };
    if current != dest {
        migrate_pngs(&current, &dest)?;
    }
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.clip_dir = target.map(|p| p.to_string_lossy().into_owned());
    storage::save_settings(&dir, &s);
    Ok(())
}

/// 打开剪贴板，带短重试（剪贴板是单例资源，可能被其他进程短暂占用）
unsafe fn open_clipboard_retry() -> bool {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..5 {
        if OpenClipboard(None).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    false
}

/// 注册 "png" 剪贴板格式（Win+Shift+S 等截图工具使用），失败返回 0
fn register_png_format() -> u32 {
    use windows::core::PCWSTR;
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    let wide: Vec<u16> = "png\0".encode_utf16().collect();
    unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
}

fn looks_like_png(bytes: &[u8]) -> bool {
    bytes.len() > 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
}

// ---------------- 读取 ----------------

/// 查询当前剪贴板内容；与 last_seq 相同（无新内容）时返回 None。
/// 读不到或格式不支持时返回 kind="other" 并推进 seq，避免同一内容反复解析。
#[tauri::command]
pub async fn read_clipboard_state(app: AppHandle, last_seq: u64) -> Option<ClipPayload> {
    unsafe {
        use windows::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        };

        let seq = GetClipboardSequenceNumber();
        if seq == 0 || seq as u64 == last_seq {
            return None;
        }

        // 图片来源优先级内再分：PNG 注册格式（截图工具）> DIB/DIBV5 > CF_BITMAP
        let cf_png = register_png_format();
        let has_png = cf_png != 0 && IsClipboardFormatAvailable(cf_png).is_ok();
        let kind = if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            "files"
        } else if has_png
            || IsClipboardFormatAvailable(CF_DIB).is_ok()
            || IsClipboardFormatAvailable(CF_DIBV5).is_ok()
            || IsClipboardFormatAvailable(CF_BITMAP).is_ok()
        {
            "image"
        } else if IsClipboardFormatAvailable(CF_UNICODETEXT).is_ok() {
            "text"
        } else {
            "other"
        };

        let mut payload = ClipPayload {
            seq: seq as u64,
            kind: kind.to_string(),
            text: None,
            truncated: None,
            image_path: None,
            width: None,
            height: None,
            files: None,
        };

        if !open_clipboard_retry() {
            // 打不开就不推进 seq，下一轮重试
            return None;
        }

        match kind {
            "text" => match read_text_locked() {
                Ok((text, truncated)) => {
                    payload.text = Some(text);
                    payload.truncated = Some(truncated);
                }
                Err(e) => {
                    eprintln!("clipboard read text failed: {e}");
                    payload.kind = "other".into();
                }
            },
            "image" => match read_image_locked(&app, cf_png, has_png) {
                Ok((path, w, h)) => {
                    payload.image_path = Some(path);
                    payload.width = Some(w);
                    payload.height = Some(h);
                }
                Err(e) => {
                    eprintln!("clipboard read image failed: {e}");
                    payload.kind = "other".into();
                }
            },
            "files" => match read_files_locked() {
                Ok(files) => payload.files = Some(files),
                Err(e) => {
                    eprintln!("clipboard read files failed: {e}");
                    payload.kind = "other".into();
                }
            },
            _ => {}
        }

        let _ = CloseClipboard();
        Some(payload)
    }
}

/// 需在持锁状态下调用：读 CF_UNICODETEXT
unsafe fn read_text_locked() -> Result<(String, bool), String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = GetClipboardData(CF_UNICODETEXT).map_err(|e| format!("get data: {e}"))?;
    let g = HGLOBAL(handle.0);
    let size = GlobalSize(g);
    if size < 2 {
        return Ok((String::new(), false));
    }
    let ptr = GlobalLock(g);
    if ptr.is_null() {
        return Err("lock failed".into());
    }
    let result = {
        let slice = std::slice::from_raw_parts(ptr as *const u16, size / 2);
        let len = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        let mut text = String::from_utf16_lossy(&slice[..len]);
        let mut truncated = false;
        if text.chars().count() > MAX_TEXT_CHARS {
            text = text.chars().take(MAX_TEXT_CHARS).collect();
            truncated = true;
        }
        Ok((text, truncated))
    };
    let _ = GlobalUnlock(g);
    result
}

/// 需在持锁状态下调用：读取剪贴板图片并存为 PNG，返回 (路径, 宽, 高)。
/// 优先级：PNG 注册格式 > CF_DIB/CF_DIBV5 > CF_BITMAP（GetDIBits 转换）。
unsafe fn read_image_locked(
    app: &AppHandle,
    cf_png: u32,
    has_png: bool,
) -> Result<(String, i32, i32), String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        GetClipboardData, IsClipboardFormatAvailable,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let dir = images_dir(app)?;

    // 1) PNG 注册格式：原始字节直接落盘（截图工具的原生数据，无损）
    if has_png {
        if let Ok(handle) = GetClipboardData(cf_png) {
            let g = HGLOBAL(handle.0);
            let size = GlobalSize(g);
            let ptr = GlobalLock(g);
            if !ptr.is_null() {
                let bytes: Vec<u8> =
                    std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                let _ = GlobalUnlock(g);
                if looks_like_png(&bytes) {
                    let (w, h) = png_dims(&bytes);
                    let out = dir.join(format!("{}.png", Uuid::new_v4()));
                    std::fs::write(&out, &bytes)
                        .map_err(|e| format!("save png: {e}"))?;
                    return Ok((out.to_string_lossy().into_owned(), w, h));
                }
            } else {
                let _ = GlobalUnlock(g);
            }
        }
    }

    // 2) DIB / DIBV5
    for fmt in [CF_DIBV5, CF_DIB] {
        let Ok(handle) = GetClipboardData(fmt) else {
            continue;
        };
        let g = HGLOBAL(handle.0);
        let size = GlobalSize(g);
        let ptr = GlobalLock(g);
        if ptr.is_null() {
            return Err("lock failed".into());
        }
        let dib: Vec<u8> = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(g);

        let (rgba, w, h) = dib_to_rgba(&dib)?;
        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or("bitmap buffer mismatch")?;
        let out = dir.join(format!("{}.png", Uuid::new_v4()));
        img.save(&out).map_err(|e| format!("save png: {e}"))?;
        return Ok((out.to_string_lossy().into_owned(), w, h));
    }

    // 3) CF_BITMAP 兜底：部分工具只放位图句柄
    if IsClipboardFormatAvailable(CF_BITMAP).is_ok() {        if let Ok(handle) = GetClipboardData(CF_BITMAP) {
            let (rgba, w, h) = bitmap_to_rgba(handle)?;
            let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
                .ok_or("bitmap buffer mismatch")?;
            let out = dir.join(format!("{}.png", Uuid::new_v4()));
            img.save(&out).map_err(|e| format!("save png: {e}"))?;
            return Ok((out.to_string_lossy().into_owned(), w, h));
        }
    }

    Err("no supported image format".into())
}

/// 从 PNG 字节里取 IHDR 的宽高（大端）
fn png_dims(bytes: &[u8]) -> (i32, i32) {
    if bytes.len() < 24 {
        return (0, 0);
    }
    let be = |o: usize| {
        i32::from_be_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
    };
    (be(16), be(20))
}

/// CF_BITMAP → RGBA（复用图标提取的 GetDIBits 流程，32bpp 自上而下）
unsafe fn bitmap_to_rgba(hbitmap: windows::Win32::Foundation::HANDLE) -> Result<(Vec<u8>, i32, i32), String> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS,
    };
    use windows::Win32::Graphics::Gdi::HBITMAP;

    let hbmp = HBITMAP(hbitmap.0);
    let mut bmp = BITMAP::default();
    let got = GetObjectW(
        hbmp.into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    );
    if got == 0 || bmp.bmWidth == 0 || bmp.bmHeight == 0 {
        return Err("cannot read bitmap info".into());
    }
    let w = bmp.bmWidth;
    let h = bmp.bmHeight.unsigned_abs() as i32;
    if (w as i64) * (h as i64) > MAX_IMAGE_PIXELS {
        return Err("image too large".into());
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // 负值 = 自上而下
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;

    let mut buf = vec![0u8; w as usize * h as usize * 4];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return Err("GetDIBits failed".into());
    }
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA → RGBA
    }
    ensure_alpha(&mut buf);
    Ok((buf, w, h))
}

/// 解析 DIB/DIBV5（BITMAPVxHEADER 起始的裸数据）为 RGBA 像素。
/// 支持 BI_RGB 与 BI_BITFIELDS（含 V4/V5 头内掩码），24/32bpp。
fn dib_to_rgba(dib: &[u8]) -> Result<(Vec<u8>, i32, i32), String> {
    if dib.len() < 40 {
        return Err("dib too small".into());
    }
    let rd_u32 = |off: usize| u32::from_le_bytes([dib[off], dib[off + 1], dib[off + 2], dib[off + 3]]);
    let rd_i32 = |off: usize| i32::from_le_bytes([dib[off], dib[off + 1], dib[off + 2], dib[off + 3]]);
    let rd_u16 = |off: usize| u16::from_le_bytes([dib[off], dib[off + 1]]);

    let header_size = rd_u32(0) as usize;
    let width = rd_i32(4);
    let height = rd_i32(8);
    let bit_count = rd_u16(14);
    let compression = rd_u32(16);

    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    if compression != BI_RGB && compression != BI_BITFIELDS {
        return Err(format!("unsupported compression {compression}"));
    }
    if width <= 0 || height == 0 || (bit_count != 24 && bit_count != 32) {
        return Err(format!("unsupported dib {width}x{height}@{bit_count}"));
    }
    let top_down = height < 0;
    let rows = height.unsigned_abs() as i64;
    if (width as i64) * rows > MAX_IMAGE_PIXELS {
        return Err("image too large".into());
    }

    // 掩码解析：
    // - BI_RGB 默认 BGRA 布局；
    // - BI_BITFIELDS + 旧头(40)：掩码紧随头部，顺序 R,G,B；
    // - V4/V5 头(≥108)：掩码在头内固定偏移 40..56。
    let (r_mask, g_mask, b_mask, a_mask) = match compression {
        BI_BITFIELDS => {
            if header_size >= 108 {
                (
                    rd_u32(40),
                    rd_u32(44),
                    rd_u32(48),
                    if header_size >= 112 { rd_u32(52) } else { 0 },
                )
            } else if dib.len() >= header_size + 12 {
                (
                    rd_u32(header_size),
                    rd_u32(header_size + 4),
                    rd_u32(header_size + 8),
                    0,
                )
            } else {
                (0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0)
            }
        }
        _ => (0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0),
    };

    // 调色板（低色深才有）；24/32bpp 无调色板
    let clr_used = if header_size >= 36 { rd_u32(32) } else { 0 } as usize;
    let palette_entries = if bit_count <= 8 {
        if clr_used > 0 {
            clr_used
        } else {
            1usize << bit_count
        }
    } else if compression == BI_BITFIELDS && header_size < 108 {
        3 // 旧头的三个掩码 DWORD 占据调色板位置
    } else {
        0
    };
    let pixel_off = header_size + palette_entries * 4;
    let stride = (((width as i64) * bit_count as i64 + 31) / 32 * 4) as usize;
    let need = pixel_off as i64 + stride as i64 * rows;
    if (dib.len() as i64) < need {
        return Err("dib truncated".into());
    }

    let mask_shift = |mask: u32| -> (u32, u32) {
        if mask == 0 {
            return (0, 0);
        }
        let shift = mask.trailing_zeros();
        let bits = (32 - shift - (mask >> shift).leading_zeros()).max(1);
        (shift, bits.min(8))
    };
    // 按掩码取出通道值；位宽不足 8 时线性放大到 0..255
    let extract = |px: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 255;
        }
        let (shift, bits) = mask_shift(mask);
        let v = (px & mask) >> shift;
        if bits >= 8 {
            (v >> (bits - 8)) as u8
        } else {
            let max = (1u32 << bits) - 1;
            ((v * 255 + max / 2) / max) as u8
        }
    };

    let w = width as usize;
    let r = rows as usize;
    let mut rgba = vec![0u8; w * r * 4];
    let is_32 = bit_count == 32;
    for y in 0..r {
        // DIB 默认自下而上存储；负高度表示自上而下
        let src_y = if top_down { y } else { r - 1 - y };
        let row = &dib[pixel_off + src_y * stride..];
        for x in 0..w {
            let px: u32 = if is_32 {
                u32::from_le_bytes([row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]])
            } else {
                let off = x * 3;
                u32::from_le_bytes([row[off], row[off + 1], row[off + 2], 0])
            };
            let dst = (y * w + x) * 4;
            rgba[dst] = extract(px, r_mask);
            rgba[dst + 1] = extract(px, g_mask);
            rgba[dst + 2] = extract(px, b_mask);
            rgba[dst + 3] = if a_mask != 0 { extract(px, a_mask) } else { 255 };
        }
    }
    ensure_alpha(&mut rgba);
    Ok((rgba, width, rows as i32))
}

/// 很多来源的 alpha 位全为 0，此时按不透明处理
fn ensure_alpha(rgba: &mut [u8]) {
    let any_alpha = rgba.iter().skip(3).step_by(4).any(|&a| a != 0);
    if !any_alpha {
        for a in rgba.iter_mut().skip(3).step_by(4) {
            *a = 255;
        }
    }
}

/// 需在持锁状态下调用：读 CF_HDROP 文件列表
unsafe fn read_files_locked() -> Result<Vec<String>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = GetClipboardData(CF_HDROP).map_err(|e| format!("get data: {e}"))?;
    let g = HGLOBAL(handle.0);
    let size = GlobalSize(g);
    let ptr = GlobalLock(g);
    if ptr.is_null() {
        return Err("lock failed".into());
    }
    let raw: Vec<u8> = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(g);

    if raw.len() < 20 {
        return Err("hdrop too small".into());
    }
    let files_off = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    let wide = u32::from_le_bytes([raw[16], raw[17], raw[18], raw[19]]) != 0;
    if files_off >= raw.len() {
        return Err("bad hdrop offset".into());
    }

    let mut files = Vec::new();
    if wide {
        let tail = &raw[files_off..];
        let units: Vec<u8> = tail.to_vec();
        let words: Vec<u16> = units
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let mut start = 0usize;
        for (i, w) in words.iter().enumerate() {
            if *w == 0 {
                if i > start {
                    let s = String::from_utf16_lossy(&words[start..i]);
                    if !s.is_empty() {
                        files.push(s);
                    }
                }
                start = i + 1;
                // 双 NUL 结束
                if start < words.len() && words[start] == 0 {
                    break;
                }
            }
        }
    } else {
        let tail = &raw[files_off..];
        let mut start = 0usize;
        for (i, b) in tail.iter().enumerate() {
            if *b == 0 {
                if i > start {
                    let s = String::from_utf8_lossy(&tail[start..i]).into_owned();
                    if !s.is_empty() {
                        files.push(s);
                    }
                }
                start = i + 1;
                if start < tail.len() && tail[start] == 0 {
                    break;
                }
            }
        }
    }
    files.truncate(MAX_FILE_ENTRIES);
    Ok(files)
}

// ---------------- 写入 ----------------

/// 把当前进程持有的分配块设为剪贴板内容；成功后所有权移交系统。
/// 返回写入后的新序列号。
pub(crate) unsafe fn set_clipboard_data(
    format: u32,
    build: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<u64, String> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, SetClipboardData,
    };
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let data = build()?;
    if !open_clipboard_retry() {
        return Err("无法打开剪贴板（被其他程序占用）".into());
    }
    let outcome = (|| -> Result<(), String> {
        EmptyClipboard().map_err(|e| format!("empty: {e}"))?;
        if data.is_empty() {
            return Ok(());
        }
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, data.len())
            .map_err(|e| format!("alloc: {e}"))?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("lock failed".into());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
        let _ = GlobalUnlock(hglobal);
        if SetClipboardData(format, Some(HANDLE(hglobal.0))).is_err() {
            let _ = GlobalFree(Some(hglobal));
            return Err("set data failed".into());
        }
        Ok(())
    })();
    let _ = CloseClipboard();
    outcome?;
    Ok(GetClipboardSequenceNumber() as u64)
}

#[tauri::command]
pub async fn write_clipboard_text(text: String) -> Result<u64, String> {
    if text.is_empty() {
        return Err("内容为空".into());
    }
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let bytes: Vec<u8> = units.iter().flat_map(|w| w.to_le_bytes()).collect();
    unsafe { set_clipboard_data(CF_UNICODETEXT, move || Ok(bytes)) }
}

#[tauri::command]
pub async fn write_clipboard_files(paths: Vec<String>) -> Result<u64, String> {
    if paths.is_empty() {
        return Err("路径列表为空".into());
    }
    // DROPFILES 头 20 字节：pFiles=20, pt={0,0}, fNC=0, fWide=1
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&20u32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    buf.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    buf.extend_from_slice(&0u32.to_le_bytes()); // fNC
    buf.extend_from_slice(&1u32.to_le_bytes()); // fWide
    for p in paths.iter().take(MAX_FILE_ENTRIES) {
        for w in p.encode_utf16().chain(std::iter::once(0)) {
            buf.extend_from_slice(&w.to_le_bytes());
        }
    }
    buf.extend_from_slice(&0u16.to_le_bytes()); // 列表结束的双 NUL
    unsafe { set_clipboard_data(CF_HDROP, move || Ok(buf)) }
}

// ---------------- 图片文件管理 ----------------

/// 校验路径必须是允许目录内的 `<uuid>.png`，防止路径穿越与任意读取
pub(crate) fn validate_clip_image_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let name_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            n.len() == 40 // 36 (uuid) + 4 (.png)
                && n.ends_with(".png")
                && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        })
        .unwrap_or(false);
    let mut allowed: Vec<PathBuf> = Vec::new();
    if let Some(d) = configured_clip_dir(app)? {
        allowed.push(d);
    }
    allowed.push(default_images_dir(app)?);
    if !name_ok || !allowed.iter().any(|d| p.parent() == Some(d.as_path())) {
        return Err("非法的图片路径".into());
    }
    Ok(p)
}

/// 删除历史条目对应的图片文件。
#[tauri::command]
pub async fn delete_clipboard_image(app: AppHandle, path: String) -> Result<(), String> {
    let p = validate_clip_image_path(&app, &path)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 返回图片的 data-url（最长边超过 max_edge 时等比缩小），供缩略图/贴图窗使用。
/// 走命令而非 asset 协议，自选保存目录也能正常显示。
#[tauri::command]
pub async fn clip_image_data_url(
    app: AppHandle,
    path: String,
    max_edge: f64,
) -> Result<String, String> {
    let p = validate_clip_image_path(&app, &path)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    let mut img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败：{e}"))?;
    if max_edge > 0.0 {
        let (w, h) = (img.width() as f64, img.height() as f64);
        let longest = w.max(h);
        if longest > max_edge && longest > 0.0 {
            let ratio = max_edge / longest;
            img = img.resize(
                ((w * ratio).round() as u32).max(1),
                ((h * ratio).round() as u32).max(1),
                image::imageops::FilterType::Triangle,
            );
        }
    }
    let mut out = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut out),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("编码失败：{e}"))?;
    use base64::Engine as _;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

/// RGBA 像素 → DIB 字节（BITMAPINFOHEADER(40) + 自下而上 BGRA）。
/// 供写剪贴板与截图流程共用。
pub(crate) fn build_dib_from_rgba(rgba: &image::RgbaImage) -> Vec<u8> {
    let w = rgba.width() as i32;
    let h = rgba.height() as i32;
    let mut dib: Vec<u8> = Vec::with_capacity(40 + (rgba.len()));
    dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
    dib.extend_from_slice(&w.to_le_bytes()); // biWidth
    dib.extend_from_slice(&h.to_le_bytes()); // biHeight（正数 = 自下而上）
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    dib.extend_from_slice(&(rgba.len() as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    dib.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    let (w, h) = (rgba.width(), rgba.height());
    for yy in (0..h).rev() {
        for xx in 0..w {
            let px = rgba.get_pixel(xx, yy);
            dib.push(px[2]);
            dib.push(px[1]);
            dib.push(px[0]);
            dib.push(px[3]);
        }
    }
    dib
}

/// 把库内 PNG 写回系统剪贴板（CF_DIB），返回新序列号用于抑制自录
#[tauri::command]
pub async fn write_clipboard_image(app: AppHandle, path: String) -> Result<u64, String> {
    let p = validate_clip_image_path(&app, &path)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败：{e}"))?;
    let rgba = img.to_rgba8();
    let dib = build_dib_from_rgba(&rgba);
    unsafe { set_clipboard_data(CF_DIB, move || Ok(dib)) }
}

/// 把现成 RGBA 帧写入系统剪贴板（CF_DIB）。截图流程使用。
pub(crate) async fn write_rgba_to_clipboard(
    rgba: image::RgbaImage,
) -> Result<u64, String> {
    let dib = build_dib_from_rgba(&rgba);
    unsafe { set_clipboard_data(CF_DIB, move || Ok(dib)) }
}

//! 历史剪贴板小组件后端：轮询读取系统剪贴板、回填文本 / 文件列表。
//!
//! 设计要点：
//! - 前端以 `read_clipboard_state(last_seq)` 轮询，`GetClipboardSequenceNumber`
//!   未变化时直接返回 None（一次轻量系统调用，不开剪贴板）。
//! - 写命令返回写入后的新序列号，前端用它抑制"自己复制导致再次入库"。
//! - 图片仅支持 CF_DIB 的 24/32bpp BI_RGB（覆盖绝大多数截图与复制场景），
//!   解码为 PNG 存到 `<app_data>/clipboard_images/`，其余格式标记为 other 跳过。

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// 单条文本入库上限（字符），超出截断并标记 truncated
const MAX_TEXT_CHARS: usize = 20_000;
/// 图片像素总量上限（约 8K x 8K）
const MAX_IMAGE_PIXELS: i64 = 8192i64 * 8192;
/// 单条文件列表上限
const MAX_FILE_ENTRIES: usize = 64;

const CF_DIB: u32 = 8;
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

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("clipboard_images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
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

        let kind = if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            "files"
        } else if IsClipboardFormatAvailable(CF_DIB).is_ok() {
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
            "image" => match read_image_locked(&app) {
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

/// 需在持锁状态下调用：读 CF_DIB 并存为 PNG，返回 (路径, 宽, 高)
unsafe fn read_image_locked(app: &AppHandle) -> Result<(String, i32, i32), String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = GetClipboardData(CF_DIB).map_err(|e| format!("get data: {e}"))?;
    let g = HGLOBAL(handle.0);
    let size = GlobalSize(g);
    let ptr = GlobalLock(g);
    if ptr.is_null() {
        return Err("lock failed".into());
    }
    let dib: Vec<u8> = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(g);

    let (rgba, w, h) = dib_to_rgba(&dib)?;

    let dir = images_dir(app)?;
    let out = dir.join(format!("{}.png", Uuid::new_v4()));
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
        .ok_or("bitmap buffer mismatch")?;
    img.save(&out).map_err(|e| format!("save png: {e}"))?;
    Ok((out.to_string_lossy().into_owned(), w, h))
}

/// 解析 DIB（BITMAPINFOHEADER 起始的裸数据）为 RGBA 像素
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

    if compression != 0 {
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

    // 调色板（低色深才有）；24/32bpp 无调色板
    let clr_used = if header_size >= 36 { rd_u32(32) } else { 0 } as usize;
    let palette_entries = if bit_count <= 8 {
        if clr_used > 0 {
            clr_used
        } else {
            1usize << bit_count
        }
    } else {
        0
    };
    let pixel_off = header_size + palette_entries * 4;
    let stride = (((width as i64) * bit_count as i64 + 31) / 32 * 4) as usize;
    let need = pixel_off as i64 + stride as i64 * rows;
    if (dib.len() as i64) < need {
        return Err("dib truncated".into());
    }

    let w = width as usize;
    let r = rows as usize;
    let mut rgba = vec![0u8; w * r * 4];
    let mut any_alpha = false;
    for y in 0..r {
        // DIB 默认自下而上存储；负高度表示自上而下
        let src_y = if top_down { y } else { r - 1 - y };
        let row = &dib[pixel_off + src_y * stride..];
        for x in 0..w {
            let (b, g, rr, a) = match bit_count {
                32 => (row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]),
                _ => {
                    let off = x * 3;
                    (row[off], row[off + 1], row[off + 2], 255)
                }
            };
            let dst = (y * w + x) * 4;
            rgba[dst] = rr;
            rgba[dst + 1] = g;
            rgba[dst + 2] = b;
            rgba[dst + 3] = a;
            if a != 0 {
                any_alpha = true;
            }
        }
    }
    // 很多来源的 32bpp alpha 位全为 0，此时按不透明处理
    if !any_alpha {
        for a in rgba.iter_mut().skip(3).step_by(4) {
            *a = 255;
        }
    }
    Ok((rgba, width, rows as i32))
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
unsafe fn set_clipboard_data(
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

/// 删除历史条目对应的图片文件。只允许删除 clipboard_images 目录内的
/// `<uuid>.png`，防止路径穿越。
#[tauri::command]
pub async fn delete_clipboard_image(app: AppHandle, path: String) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let p = PathBuf::from(&path);
    let name_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            n.len() == 40 // 36 (uuid) + 4 (.png)
                && n.ends_with(".png")
                && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        })
        .unwrap_or(false);
    if !name_ok || p.parent() != Some(dir.as_path()) {
        return Err("非法的图片路径".into());
    }
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

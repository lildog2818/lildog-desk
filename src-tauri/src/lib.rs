mod clipboard;
mod icons;
mod links;
mod storage;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

#[derive(Clone, Debug)]
struct TrayEntry {
    id: String,
    title: String,
    width: f64,
    height: f64,
}

/// 待松手提交的吸附目标
#[derive(Clone, Copy)]
struct PendingSnap {
    x: i32,
    y: i32,
    at: Instant,
}

/// 待松手提交的尺寸落位（含边缘锚定修正后的位置）
#[derive(Clone, Copy)]
struct PendingResize {
    w: u32,
    h: u32,
    x: i32,
    y: i32,
    at: Instant,
}

/// 一次进行中的尺寸调节会话
#[derive(Clone)]
struct ResizeSession {
    lw: f64,
    lh: f64,
    gen: u64,
    at: Instant,
    /// 本次调节开始时的物理位置：与结束时比较可判断用户拖的是哪条边
    start_pos: Option<(i32, i32)>,
}

#[derive(Default)]
struct AppState {
    last_save: Mutex<Option<Instant>>,
    latest_pos: Mutex<HashMap<String, (i32, i32)>>,
    latest_size: Mutex<HashMap<String, (f64, f64)>>,
    /// 拖动中产生的吸附预览目标：label -> 目标（松开鼠标左键时统一落位）
    pending_snap: Mutex<HashMap<String, PendingSnap>>,
    /// 调节尺寸中的预览落位目标
    pending_resize: Mutex<HashMap<String, PendingResize>>,
    /// 当前固定（置顶）的窗口：固定的窗口自动解除吸附
    pinned_set: Mutex<HashSet<String>>,
    /// 鼠标释放监听线程是否已启动
    watcher_started: AtomicBool,
    /// 去抖中的尺寸调节：label -> 会话
    resize_pending: Mutex<HashMap<String, ResizeSession>>,
    /// 程序化尺寸变更守卫：label -> 守卫截止时刻。
    /// 折叠/展开等由命令发起的 set_size 期间，Moved/Resized 不做吸附与阶梯预览，
    /// 避免预提交机制把窗口又拉回原位（表现为"折叠没反应/乱跳"）。
    programmatic_until: Mutex<HashMap<String, Instant>>,
    glass_value: Mutex<f64>,
    size_step: Mutex<u32>,
    tray_items: Mutex<Vec<TrayEntry>>,
    /// 贴图窗自增序号（生成唯一 label）
    pin_seq: AtomicU64,
    /// 贴图窗待取载荷：label -> (path, w, h)。前端就绪后主动拉取，
    /// 避免"先 emit 后监听"的竞态导致窗口永远空白。
    pending_pins: Mutex<HashMap<String, (String, i32, i32)>>,
    /// 热键呼出面板时记录的前台窗口，粘贴时还原焦点
    last_foreground: Mutex<isize>,
    /// 进行中的截图用途：0=无 1=复制到剪贴板 2=自动贴图
    shot_target: Mutex<u8>,
    /// 已注册的全局热键：shortcut -> 用途（1/2/3）
    hotkey_map: Mutex<Vec<(tauri_plugin_global_shortcut::Shortcut, u8)>>,
}

// ---------------- 小组件数据 ----------------

#[tauri::command]
fn load_widget_data(
    app: AppHandle,
    widget_id: String,
) -> Option<serde_json::Value> {
    storage::load_widget_data(&storage::data_dir(&app), &widget_id)
}

#[tauri::command]
fn save_widget_data(
    app: AppHandle,
    widget_id: String,
    data: serde_json::Value,
) -> Result<(), String> {
    storage::save_widget_data(&storage::data_dir(&app), &widget_id, &data)
}

// ---------------- 窗口状态 ----------------
//
// 注意：涉及窗口 getter/setter 的命令必须声明为 async，
// 同步命令在主线程执行，而窗口操作需要事件循环响应，会造成死锁。

#[tauri::command]
async fn get_window_state(
    app: AppHandle,
    win: WebviewWindow,
) -> Result<serde_json::Value, String> {
    let dir = storage::data_dir(&app);
    let settings = storage::load_settings(&dir);
    let mut st = settings.window(win.label());
    st.bg_opacity = settings.global_bg_opacity();
    st.glass = settings.global_glass();
    Ok(serde_json::json!({
        "pinned": st.pinned,
        "collapsed": st.collapsed,
        "bgOpacity": st.bg_opacity,
        "glass": st.glass,
        "sizeStep": settings.size_step(),
        "fontColor": settings.font_color(),
        "bgColor": settings.bg_color(),
        "textStroke": settings.text_stroke.unwrap_or(true),
    }))
}

/// 文字描边开关：广播到所有窗口
#[tauri::command]
async fn set_text_stroke(app: AppHandle, enabled: bool) -> Result<(), String> {
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.text_stroke = Some(enabled);
    storage::save_settings(&dir, &s);
    let _ = app.emit("text-stroke", enabled);
    Ok(())
}

fn valid_hex_color(s: &str) -> bool {
    s.is_empty()
        || (s.len() == 7
            && s.starts_with('#')
            && s[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

/// 统一设置主题色：字体 / 背景（空字符串表示恢复默认），并广播到所有窗口。
/// 小字体颜色由前端按字体色自动派生，不再单独设置。
#[tauri::command]
async fn set_theme(app: AppHandle, font_color: String, bg_color: String) -> Result<(), String> {
    for v in [&font_color, &bg_color] {
        if !valid_hex_color(v) {
            return Err(format!("非法颜色值：{v}"));
        }
    }
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.font_color = Some(font_color).filter(|v| !v.is_empty());
    s.bg_color = Some(bg_color).filter(|v| !v.is_empty());
    storage::save_settings(&dir, &s);
    let _ = app.emit(
        "theme",
        serde_json::json!({
            "fontColor": s.font_color,
            "bgColor": s.bg_color,
        }),
    );
    Ok(())
}

/// 设置尺寸步进（逻辑像素）。仅影响后续的尺寸调节，不改动已打开窗口。
#[tauri::command]
async fn set_size_step(app: AppHandle, step: f64) -> Result<(), String> {
    let s32 = (step.round() as u32).clamp(8, 200);
    *app.state::<AppState>().size_step.lock().unwrap() = s32;
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.size_step = Some(s32);
    storage::save_settings(&dir, &s);
    Ok(())
}

#[tauri::command]
async fn set_pinned(
    app: AppHandle,
    win: WebviewWindow,
    pin: bool,
) -> Result<(), String> {
    win.set_always_on_top(pin).map_err(|e| e.to_string())?;
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.update_window(win.label(), |st| st.pinned = pin);
    storage::save_settings(&dir, &s);
    // 同步内存缓存：固定的窗口不参与吸附
    let label = win.label().to_string();
    let state = app.state::<AppState>();
    if pin {
        state.pinned_set.lock().unwrap().insert(label);
    } else {
        state.pinned_set.lock().unwrap().remove(&label);
    }
    Ok(())
}

#[tauri::command]
async fn set_collapsed(
    app: AppHandle,
    win: WebviewWindow,
    collapsed: bool,
) -> Result<(), String> {
    let label = win.label().to_string();
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    // 程序化改尺寸前，清掉该窗口可能残留的吸附 / 阶梯预提交目标，
    // 防止随后任意一次鼠标释放被 watcher 提交、把窗口拉回旧位。
    {
        let state = app.state::<AppState>();
        state.pending_snap.lock().unwrap().remove(&label);
        state.pending_resize.lock().unwrap().remove(&label);
        arm_programmatic_resize(&state, &label);
    }
    let already_collapsed;
    {
        let st = s.windows.entry(label.clone()).or_default();
        already_collapsed = st.collapsed;
        if collapsed {
            // 已处于折叠态时不得把 72px 存为"展开尺寸"，否则展开永远恢复成小条
            if !already_collapsed {
                if let Ok(size) = win.inner_size() {
                    let scale = win.scale_factor().unwrap_or(1.0);
                    st.width = Some(size.width as f64 / scale);
                    st.height = Some(size.height as f64 / scale);
                }
            }
            win.set_size(LogicalSize::new(st.width.unwrap_or(340.0), COLLAPSED_LOGICAL_H))
                .map_err(|e| e.to_string())?;
        } else {
            // 历史版本可能把折叠高度误存为展开高度（缺陷修复前的脏数据），
            // 恢复时低于折叠高度的记录视为无效，回退到默认展开高度
            let restore_h = match st.height {
                Some(h) if h > COLLAPSED_LOGICAL_H => h,
                _ => 560.0,
            };
            win.set_size(LogicalSize::new(st.width.unwrap_or(340.0), restore_h))
                .map_err(|e| e.to_string())?;
        }
        st.collapsed = collapsed;
    }
    storage::save_settings(&dir, &s);
    Ok(())
}

#[tauri::command]
fn set_bg_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    let v = opacity.clamp(0.0, 1.0);
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.bg_opacity = Some(v);
    storage::save_settings(&dir, &s);
    let _ = app.emit("bg-opacity", v);
    Ok(())
}

#[cfg(target_os = "windows")]
fn dwm_set_attr(win: &WebviewWindow, attr: u32, value: u32) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};

    let Ok(raw) = win.hwnd() else {
        return false;
    };
    let hwnd = HWND(raw.0);
    let v = value as i32;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(attr as i32),
            &v as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        )
        .is_ok()
    }
}

#[cfg(target_os = "windows")]
fn apply_glass(win: &WebviewWindow, v: f64) {
    use window_vibrancy::{apply_acrylic, clear_acrylic};

    let v = v.clamp(0.0, 1.0);
    let _ = clear_acrylic(win);

    if v <= 0.001 {
        dwm_set_attr(win, 38, 1);
        return;
    }

    dwm_set_attr(win, 20, 1);
    if dwm_set_attr(win, 38, 2) {
        return;
    }

    let a = (v * 255.0).round().clamp(4.0, 250.0) as u8;
    if let Err(e) = apply_acrylic(win, Some((18, 18, 24, a))) {
        eprintln!("acrylic unavailable: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_glass(_win: &WebviewWindow, _v: f64) {}

#[tauri::command]
async fn set_glass(app: AppHandle, v: f64) -> Result<(), String> {
    let v = v.clamp(0.0, 1.0);
    *app.state::<AppState>().glass_value.lock().unwrap() = v;
    // 全局统一：应用到当前所有窗口（贴图窗/截图层除外）
    for (_, win) in app.webview_windows() {
        #[cfg(target_os = "windows")]
        if !is_chromeless_label(win.label()) {
            apply_glass(&win, v);
        }
    }
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.glass = Some(v);
    storage::save_settings(&dir, &s);
    Ok(())
}

// ---------------- 动态小组件窗口 ----------------

fn valid_widget_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 无面板外观的辅助窗口：不参与吸附、阶梯与亚克力玻璃效果
fn is_chromeless_label(label: &str) -> bool {
    label == "snap-preview" || label.starts_with("pin-") || label == "shot-overlay"
}

fn ensure_widget_window(
    app: &AppHandle,
    widget_id: &str,
    title: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("w-{widget_id}");
    if !valid_widget_id(widget_id) {
        return Err("非法的组件 id".into());
    }
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let dir = storage::data_dir(app);
    let settings = storage::load_settings(&dir);
    let st = settings.window(&label);
    let glass = settings.global_glass();
    let step = *app.state::<AppState>().size_step.lock().unwrap();
    // 折叠态的窗口按 pill 高度还原，与前端 body.collapsed 外观保持一致
    let w = quantize_logical(st.width.unwrap_or(width).max(160.0), step, 160.0);
    let h = if st.collapsed {
        COLLAPSED_LOGICAL_H
    } else {
        quantize_logical(st.height.unwrap_or(height).max(96.0), step, 96.0)
    };

    let win = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(w, h)
    .min_inner_size(160.0, 72.0)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        apply_glass(&win, glass);
        round_window_corners(&win);
    }

    if let (Some(x), Some(y)) = (st.x, st.y) {
        let (cx, cy) = clamp_fully_in_monitors(&win, x, y);
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
        app.state::<AppState>()
            .latest_pos
            .lock()
            .unwrap()
            .insert(label.clone(), (cx, cy));
    } else {
        let _ = win.center();
    }

    if let Ok(sz) = win.inner_size() {
        let scale = win.scale_factor().unwrap_or(1.0);
        app.state::<AppState>()
            .latest_size
            .lock()
            .unwrap()
            .insert(label.clone(), (sz.width as f64 / scale, sz.height as f64 / scale));
    }
    *app.state::<AppState>().glass_value.lock().unwrap() = glass;

    if st.pinned {
        let _ = win.set_always_on_top(true);
        app.state::<AppState>()
            .pinned_set
            .lock()
            .unwrap()
            .insert(label);
    }

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
async fn open_widget_window(
    app: AppHandle,
    widget_id: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    ensure_widget_window(&app, &widget_id, &title, width, height)
}

#[tauri::command]
async fn toggle_widget_window(
    app: AppHandle,
    widget_id: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("w-{widget_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        if existing.is_visible().unwrap_or(false) {
            let _ = existing.hide();
            return Ok(());
        }
    }
    ensure_widget_window(&app, &widget_id, &title, width, height)
}

/// 仅隐藏组件悬浮窗；不存在时静默成功（区别于 toggle 的"未开则打开"）
#[tauri::command]
async fn close_widget_window(app: AppHandle, widget_id: String) -> Result<(), String> {
    let label = format!("w-{widget_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
    }
    Ok(())
}

// ---------------- 贴图窗 ----------------

const PIN_MAX_W: i32 = 1400;
const PIN_MAX_H: i32 = 900;

/// 打开贴图窗：等比缩放至屏幕友好尺寸；图片数据由前端就绪后
/// 通过 take_pin_payload 拉取（emit 仅作尽力而为的加速路径）
pub(crate) async fn open_pin_window(
    app: &AppHandle,
    path: String,
    w: i32,
    h: i32,
) -> Result<(), String> {
    clipboard::validate_clip_image_path(app, &path)?;
    if w <= 0 || h <= 0 {
        return Err("图片尺寸无效".into());
    }
    let ratio = 1.0_f64
        .min(PIN_MAX_W as f64 / w as f64)
        .min(PIN_MAX_H as f64 / h as f64);
    let pw = ((w as f64 * ratio).round() as i32).max(24);
    let ph = ((h as f64 * ratio).round() as i32).max(24);

    let seq = app.state::<AppState>().pin_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("pin-{seq}");
    let win = if let Some(existing) = app.get_webview_window(&label) {
        existing
    } else {
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("贴图")
            .inner_size(200.0, 150.0)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .always_on_top(true)
            .build()
            .map_err(|e| e.to_string())?
    };
    #[cfg(target_os = "windows")]
    round_window_corners(&win);
    // 贴图窗不参与玻璃效果：清掉可能残留的亚克力
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, clear_acrylic};
        let _ = clear_acrylic(&win);
        let _ = apply_acrylic(&win, Some((18, 18, 24, 255)));
    }
    let _ = win.set_size(tauri::PhysicalSize::new(pw.max(1) as u32, ph.max(1) as u32));
    let _ = win.show();
    let _ = win.set_focus();

    // 存待取载荷；emit 只是加速路径，前端拉取兜底
    app.state::<AppState>()
        .pending_pins
        .lock()
        .unwrap()
        .insert(label.clone(), (path, w, h));
    let _ = app.emit_to(
        &label,
        "pin-image",
        serde_json::json!({}),
    );
    Ok(())
}

/// 贴图窗前端就绪后拉取自己的图片数据并清除待取项
#[tauri::command]
async fn take_pin_payload(
    app: AppHandle,
    win: WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    let label = win.label().to_string();
    let payload = app.state::<AppState>().pending_pins.lock().unwrap().remove(&label);
    Ok(payload.map(|(path, width, height)| {
        serde_json::json!({ "path": path, "width": width, "height": height })
    }))
}

#[tauri::command]
async fn open_image_pin(
    app: AppHandle,
    path: String,
    w: i32,
    h: i32,
) -> Result<(), String> {
    open_pin_window(&app, path, w, h).await
}

// ---------------- 区域截图 ----------------

/// 启动截图：在光标所在显示器上铺满覆盖层，等待前端回传选区
fn launch_shot(app: &AppHandle, target: u8) -> Result<(), String> {
    *app.state::<AppState>().shot_target.lock().unwrap() = target;

    #[cfg(target_os = "windows")]
    let (mx, my, mw, mh) = unsafe {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let _ = GetMonitorInfoW(mon, &mut mi);
        (
            mi.rcMonitor.left,
            mi.rcMonitor.top,
            mi.rcMonitor.right - mi.rcMonitor.left,
            mi.rcMonitor.bottom - mi.rcMonitor.top,
        )
    };
    #[cfg(not(target_os = "windows"))]
    let (mx, my, mw, mh) = (0, 0, 1200, 800);

    if mw < 8 || mh < 8 {
        return Err("无法获取显示器信息".into());
    }

    let win = if let Some(win) = app.get_webview_window("shot-overlay") {
        win
    } else {
        WebviewWindowBuilder::new(
            app,
            "shot-overlay",
            WebviewUrl::App("index.html".into()),
        )
        .title("截图")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .always_on_top(true)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?
    };
    let _ = win.set_size(tauri::PhysicalSize::new(mw.max(1) as u32, mh.max(1) as u32));
    let _ = win.set_position(PhysicalPosition::new(mx, my));
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    let _ = win.set_focus();

    let scale = win.scale_factor().unwrap_or(1.0);
    let _ = app.emit_to(
        "shot-overlay",
        "shot-context",
        serde_json::json!({
            "originX": mx, "originY": my,
            "scale": scale, "width": mw, "height": mh,
            "target": target,
        }),
    );
    Ok(())
}

#[tauri::command]
async fn start_shot(app: AppHandle, target: String) -> Result<(), String> {
    launch_shot(&app, if target == "pin" { 2 } else { 1 })
}

/// GDI 抓取屏幕物理区域为 RGBA
#[cfg(target_os = "windows")]
unsafe fn capture_screen_region(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<image::RgbaImage, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDIBits, GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };

    if w <= 0 || h <= 0 {
        return Err("选区尺寸无效".into());
    }
    let hdc_screen = GetWindowDC(None);
    if hdc_screen.is_invalid() {
        return Err("获取屏幕 DC 失败".into());
    }
    let mem = CreateCompatibleDC(Some(hdc_screen));
    let bmp = CreateCompatibleBitmap(hdc_screen, w, h);
    if bmp.is_invalid() {
        return Err("创建兼容位图失败".into());
    }
    let old = SelectObject(mem, bmp.into());

    let blt = BitBlt(
        mem,
        0,
        0,
        w,
        h,
        Some(hdc_screen),
        x,
        y,
        SRCCOPY | CAPTUREBLT,
    );

    let mut buf = vec![0u8; w as usize * h as usize * 4];
    if blt.is_ok() {
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // 自上而下
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = 0;
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("读取屏幕像素失败".into());
        }
    } else {
        return Err("屏幕拷贝失败".into());
    }

    let _ = SelectObject(mem, old);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, hdc_screen);

    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA → RGBA
    }
    image::RgbaImage::from_raw(w as u32, h as u32, buf).ok_or_else(|| "像素缓冲不匹配".into())
}

/// 前端松开鼠标后提交物理坐标选区；按用途写剪贴板或直接贴图
#[tauri::command]
async fn commit_shot_rect(
    app: AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<String, String> {
    let target = *app.state::<AppState>().shot_target.lock().unwrap();
    if target == 0 {
        return Err("没有进行中的截图".into());
    }
    if let Some(win) = app.get_webview_window("shot-overlay") {
        let _ = win.hide();
    }
    std::thread::sleep(Duration::from_millis(130));

    #[cfg(target_os = "windows")]
    let rgba = unsafe { capture_screen_region(x, y, w.max(1), h.max(1))? };
    #[cfg(not(target_os = "windows"))]
    let rgba = image::RgbaImage::new(1, 1);

    let (iw, ih) = (rgba.width() as i32, rgba.height() as i32);
    let dir = clipboard::images_dir(&app)?;
    let out = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    rgba.save(&out).map_err(|e| format!("保存截图失败:{e}"))?;

    clipboard::write_rgba_to_clipboard(rgba).await?;

    let path = out.to_string_lossy().into_owned();
    if target == 2 {
        open_pin_window(&app, path.clone(), iw, ih).await?;
    }
    *app.state::<AppState>().shot_target.lock().unwrap() = 0;
    Ok(path)
}

#[tauri::command]
async fn cancel_shot(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("shot-overlay") {
        let _ = win.hide();
    }
    *app.state::<AppState>().shot_target.lock().unwrap() = 0;
    Ok(())
}

// ---------------- 粘贴回填 ----------------

/// 把内容粘贴回热键呼出面板之前的前台窗口（还原焦点 + 模拟 Ctrl+V）
#[tauri::command]
async fn paste_to_last_target(app: AppHandle) -> Result<(), String> {
    let h = *app.state::<AppState>().last_foreground.lock().unwrap();
    if h == 0 {
        return Err("没有可粘贴的目标窗口".into());
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
            VK_V,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, ShowWindowAsync, SW_RESTORE,
        };

        let hwnd = HWND(h as *mut core::ffi::c_void);
        let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
        std::thread::sleep(Duration::from_millis(90));

        let key = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
                   up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up { KEYEVENTF_KEYUP } else {
                        windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)
                    },
                    ..Default::default()
                },
            },
        };
        let seq = [
            key(VK_CONTROL, false),
            key(VK_V, false),
            key(VK_V, true),
            key(VK_CONTROL, true),
        ];
        let sent = SendInput(&seq, std::mem::size_of::<INPUT>() as i32);
        if sent != 4 {
            return Err("模拟按键失败".into());
        }
    }
    Ok(())
}

/// 记录当前前台窗口并呼出剪贴板面板
fn summon_clipboard_panel(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let fg = GetForegroundWindow();
        *app.state::<AppState>().last_foreground.lock().unwrap() =
            fg.0 as isize;
    }
    #[cfg(not(target_os = "windows"))]
    {
        *app.state::<AppState>().last_foreground.lock().unwrap() = 0;
    }

    if let Some(win) = app.get_webview_window("w-clipboard") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let _ = toggle_widget_window_cmd(app, "clipboard", "lildog · 剪贴板", 320.0, 480.0);
    }
}

// ---------------- 托盘 ----------------

#[tauri::command]
async fn update_tray_widgets(
    app: AppHandle,
    items: Vec<TrayItemDto>,
) -> Result<(), String> {
    let entries: Vec<TrayEntry> = items
        .into_iter()
        .map(|i| TrayEntry {
            id: i.id,
            title: i.title,
            width: i.width,
            height: i.height,
        })
        .collect();
    *app.state::<AppState>().tray_items.lock().unwrap() = entries.clone();
    rebuild_tray_menu(&app, &entries)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayItemDto {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

fn rebuild_tray_menu(
    app: &AppHandle,
    items: &[TrayEntry],
) -> Result<(), String> {
    use tauri::menu::IsMenuItem;

    let Some(tray) = app.tray_by_id("tray") else {
        return Ok(());
    };
    let show_item =
        MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let mut checks: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for entry in items {
        let label = format!("w:{}", entry.id);
        let visible = app
            .get_webview_window(&label)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if let Ok(item) = CheckMenuItem::with_id(
            app,
            &label,
            &entry.title,
            true,
            visible,
            None::<&str>,
        ) {
            checks.push(item);
        }
    }

    let mut handles: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&show_item];
    if !checks.is_empty() {
        handles.push(&sep1);
        for c in &checks {
            handles.push(c);
        }
        handles.push(&sep2);
    }
    handles.push(&quit_item);

    let menu = Menu::with_items(app, &handles).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

// ---------------- HTTP（额度 API） ----------------

#[tauri::command]
async fn fetch_json(url: String, token: String) -> Result<serde_json::Value, String> {
    if !url.starts_with("https://") {
        return Err("仅允许 HTTPS 地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("lildog-desk/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
    let resp = client
        .get(&url)
        .bearer_auth(token.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {} {}", status.as_u16(), body));
    }
    serde_json::from_str(&body).map_err(|e| format!("响应解析失败：{e}"))
}

/// 从本机 opencode 登录文件自动读取 Go 订阅 key
#[tauri::command]
fn resolve_opencode_key() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户目录".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");
    let text = fs::read_to_string(&path)
        .map_err(|_| "未找到 opencode 登录文件，请先在 opencode 中登录或手动填写 Key".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "opencode auth.json 解析失败".to_string())?;

    fn key_from(entry: &serde_json::Value) -> Option<String> {
        match entry {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Object(m) => ["key", "api_key", "apiKey"]
                .iter()
                .find_map(|k| m.get(*k).and_then(|x| x.as_str()))
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string()),
            _ => None,
        }
    }

    if let Some(entry) = v.get("opencode-go").and_then(key_from) {
        return Ok(entry);
    }
    Err("auth.json 中未找到 opencode-go 的 Key，请手动填写".into())
}

// ---------------- 几何与位置记忆 ----------------

const SNAP_ENGAGE_LOGICAL: f64 = 12.0;

/// 折叠态（pill）的逻辑高度，与前端 CSS / min_inner_size 保持一致
const COLLAPSED_LOGICAL_H: f64 = 72.0;
/// 程序化尺寸变更的守卫时长：覆盖 set_size 引发的一串 Moved/Resized 事件
const PROGRAMMATIC_GUARD_MS: u64 = 400;

fn arm_programmatic_resize(state: &AppState, label: &str) {
    state
        .programmatic_until
        .lock()
        .unwrap()
        .insert(label.to_string(), Instant::now() + Duration::from_millis(PROGRAMMATIC_GUARD_MS));
}

fn is_programmatic_resize(state: &AppState, label: &str) -> bool {
    state
        .programmatic_until
        .lock()
        .unwrap()
        .get(label)
        .map_or(false, |t| Instant::now() < *t)
}

// ---------------- 吸附预览层 ----------------
//
/// 预览类型：snap=对齐吸附预览（橙色虚线）；size=阶梯尺寸预览（绿色实线）
#[derive(Clone, Copy, PartialEq)]
enum PreviewMode {
    Snap,
    Size,
}

/// 拖动过程零干预：接近目标时仅显示预览框，
/// 松开鼠标左键后一次性落位。

/// 预览悬浮窗在 setup 中预创建，此处只做复用
fn preview_show(
    app: &AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    mode: PreviewMode,
) {
    if let Some(win) = app.get_webview_window("snap-preview") {
        let _ = win.set_size(tauri::PhysicalSize::new(w.max(8) as u32, h.max(8) as u32));
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let tag = match mode {
            PreviewMode::Snap => "snap",
            PreviewMode::Size => "size",
        };
        let _ = win.eval(&format!(
            "document.documentElement.dataset.pv='{}'",
            tag
        ));
        let _ = win.show();
    }
}

fn preview_hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("snap-preview") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        }
    }
}

/// 仅当没有任何待定预览时才隐藏预览层
fn hide_preview_if_idle(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.pending_snap.lock().unwrap().is_empty()
        && state.pending_resize.lock().unwrap().is_empty()
    {
        preview_hide(app);
    }
}

/// 提交松手时的待定吸附/尺寸目标
fn commit_pending_drags(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now = Instant::now();
    let snaps: Vec<(String, (i32, i32))> = {
        let mut p = state.pending_snap.lock().unwrap();
        let keys: Vec<String> = p.keys().cloned().collect();
        let mut out = Vec::new();
        for k in keys {
            if let Some(s) = p.remove(&k) {
                // 过期目标（拖动早已结束）不提交
                if now.duration_since(s.at) < Duration::from_millis(1500) {
                    out.push((k, (s.x, s.y)));
                }
            }
        }
        out
    };
    for (label, (x, y)) in snaps {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
    }
    let resizes: Vec<(String, PendingResize)> = {
        let mut p = state.pending_resize.lock().unwrap();
        let keys: Vec<String> = p.keys().cloned().collect();
        let mut out = Vec::new();
        for k in keys {
            if let Some(r) = p.remove(&k) {
                if now.duration_since(r.at) < Duration::from_millis(1500) {
                    out.push((k, r));
                }
            }
        }
        out
    };
    for (label, r) in resizes {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_size(tauri::PhysicalSize::new(r.w, r.h));
            let _ = win.set_position(PhysicalPosition::new(r.x, r.y));
        }
    }
    // 手势结束：清空尺寸会话，下次调节重新锚定起点
    state.resize_pending.lock().unwrap().clear();
    preview_hide(app);
}

/// 全局监听鼠标左键释放，触发吸附落位（懒启动、常驻轮询，开销可忽略）
#[cfg(target_os = "windows")]
fn start_release_watcher(app: &AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    if app.state::<AppState>().watcher_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        const VK_LBUTTON: i32 = 0x01;
        let mut was_down =
            unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 };
        loop {
            std::thread::sleep(Duration::from_millis(18));
            let down = unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 };
            if was_down && !down {
                commit_pending_drags(&app);
            }
            was_down = down;
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_release_watcher(_app: &AppHandle) {}

/// 将逻辑尺寸量化到步进的整数倍，便于组件窗口对齐拼接
fn quantize_logical(v: f64, step: u32, min: f64) -> f64 {
    if step < 4 {
        return v.max(min);
    }
    let s = step as f64;
    ((v / s).round() * s).max(min)
}

/// 吸附对齐：拖动时在「其他小组件窗口的边缘」与「桌面/屏幕边缘」之间
/// 选择距离最近者给出预览对齐位。
/// 窗口之间允许重叠，除首尾拼接外还支持同边对齐（左/右/上/下）。
/// 返回 (吸附后位置, 是否处于感应区内)。感应区内即使无需位移也返回 true，
/// 用于区分「已落在目标上」和「周边没有目标」。
fn snap_position(
    win: &WebviewWindow,
    app: &AppHandle,
    x: i32,
    y: i32,
) -> ((i32, i32), bool) {
    let Ok(scale) = win.scale_factor() else {
        return ((x, y), false);
    };
    let th = (SNAP_ENGAGE_LOGICAL * scale).round() as i32;
    let Ok(size) = win.outer_size() else {
        return ((x, y), false);
    };
    let w = size.width as i32;
    let h = size.height as i32;
    if w <= 0 || h <= 0 {
        return ((x, y), false);
    }
    let l = x;
    let r = x + w;
    let t = y;
    let b = y + h;

    // 每轴维护一个最佳候选 (distance, new_coord)：
    // 组件窗边缘与屏幕边缘共同竞争，最终只应用距离最近者
    let mut best_h: Option<(i32, i32)> = None; // 水平：候选新左缘
    let mut best_v: Option<(i32, i32)> = None; // 垂直：候选新上缘

    // ---- 来源一：其他小组件窗口 ----
    for (label, other) in app.webview_windows() {
        if label == win.label()
            || is_chromeless_label(&label)
            || !other.is_visible().unwrap_or(false)
        {
            continue;
        }
        let (Ok(op), Ok(os)) = (other.outer_position(), other.outer_size()) else {
            continue;
        };
        if os.width == 0 || os.height == 0 {
            continue;
        }
        let ol = op.x;
        let or_ = op.x + os.width as i32;
        let ot = op.y;
        let ob = op.y + os.height as i32;

        // 「接近」而非严格重叠：垂直/水平范围相差不超过阈值即可参与对齐
        let v_near = t < ob + th && b > ot - th;
        if v_near {
            for (cand, d) in [
                (or_, (l - or_).abs()),     // 我左缘 ↔ 对方右缘拼接
                (ol - w, (r - ol).abs()),   // 我右缘 ↔ 对方左缘拼接
                (ol, (l - ol).abs()),       // 左缘对齐
                (or_ - w, (r - or_).abs()), // 右缘对齐
            ] {
                if d <= th && best_h.map_or(true, |(bd, _)| d < bd) {
                    best_h = Some((d, cand));
                }
            }
        }
        let h_near = l < or_ + th && r > ol - th;
        if h_near {
            for (cand, d) in [
                (ob, (t - ob).abs()),     // 我上缘 ↔ 对方下缘拼接
                (ot - h, (b - ot).abs()), // 我下缘 ↔ 对方上缘拼接
                (ot, (t - ot).abs()),     // 上缘对齐
                (ob - h, (b - ob).abs()), // 下缘对齐
            ] {
                if d <= th && best_v.map_or(true, |(bd, _)| d < bd) {
                    best_v = Some((d, cand));
                }
            }
        }
    }

    // ---- 来源二：桌面/屏幕边缘 ----
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let mp = m.position();
            let ms = m.size();
            let ml = mp.x;
            let mr = mp.x + ms.width as i32;
            let mt = mp.y;
            let mb = mp.y + ms.height as i32;

            let v_near = t < mb + th && b > mt - th;
            if v_near {
                for (cand, d) in [(ml, (l - ml).abs()), (mr - w, (r - mr).abs())] {
                    if d <= th && best_h.map_or(true, |(bd, _)| d < bd) {
                        best_h = Some((d, cand));
                    }
                }
            }
            let h_near = l < mr + th && r > ml - th;
            if h_near {
                for (cand, d) in [(mt, (t - mt).abs()), (mb - h, (b - mb).abs())] {
                    if d <= th && best_v.map_or(true, |(bd, _)| d < bd) {
                        best_v = Some((d, cand));
                    }
                }
            }
        }
    }

    let mut engaged = false;
    let nl = match best_h {
        Some((_, c)) => {
            engaged = true;
            c
        }
        None => l,
    };
    let nt = match best_v {
        Some((_, c)) => {
            engaged = true;
            c
        }
        None => t,
    };
    ((nl, nt), engaged)
}

fn clamp_fully_in_monitors(win: &WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let Ok(monitors) = win.available_monitors() else {
        return (x, y);
    };
    if monitors.is_empty() {
        return (x, y);
    }
    let size = win.outer_size().unwrap_or_default();
    if size.width == 0 || size.height == 0 {
        return (x, y);
    }
    let w = size.width as i32;
    let h = size.height as i32;

    let mut best_idx = 0usize;
    let mut best_inter = -1i64;
    for (i, m) in monitors.iter().enumerate() {
        let mp = m.position();
        let ms = m.size();
        let ix = (x + w).min(mp.x + ms.width as i32) - x.max(mp.x);
        let iy = (y + h).min(mp.y + ms.height as i32) - y.max(mp.y);
        let inter = ix.max(0) as i64 * iy.max(0) as i64;
        if inter > best_inter {
            best_inter = inter;
            best_idx = i;
        }
    }
    let mp = monitors[best_idx].position();
    let ms = monitors[best_idx].size();
    let max_x = (mp.x + ms.width as i32 - w).max(mp.x);
    let max_y = (mp.y + ms.height as i32 - h).max(mp.y);
    (x.clamp(mp.x, max_x), y.clamp(mp.y, max_y))
}

fn clamp_size_into_monitors(win: &WebviewWindow) {
    let Ok(monitors) = win.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }
    let Ok(pos) = win.outer_position() else {
        return;
    };
    let Ok(size) = win.outer_size() else {
        return;
    };

    let mut best_idx = 0usize;
    let mut best_inter = -1i64;
    for (i, m) in monitors.iter().enumerate() {
        let mp = m.position();
        let ms = m.size();
        let ix =
            (pos.x + size.width as i32).min(mp.x + ms.width as i32) - pos.x.max(mp.x);
        let iy =
            (pos.y + size.height as i32).min(mp.y + ms.height as i32) - pos.y.max(mp.y);
        let inter = ix.max(0) as i64 * iy.max(0) as i64;
        if inter > best_inter {
            best_inter = inter;
            best_idx = i;
        }
    }
    let ms = monitors[best_idx].size();
    if size.width > ms.width || size.height > ms.height {
        let _ = win.set_size(tauri::PhysicalSize::new(
            size.width.min(ms.width),
            size.height.min(ms.height),
        ));
    }
}

fn save_pos_now(app: &AppHandle) {
    let dir = storage::data_dir(app);
    let state = app.state::<AppState>();
    let positions = state.latest_pos.lock().unwrap().clone();
    let sizes = state.latest_size.lock().unwrap().clone();
    let mut s = storage::load_settings(&dir);
    for (label, (x, y)) in positions {
        s.update_window(&label, |st| {
            st.x = Some(x);
            st.y = Some(y);
            if let Some((w, h)) = sizes.get(&label) {
                if *w > 0.0 && *h > 0.0 {
                    st.width = Some(*w);
                    st.height = Some(*h);
                }
            }
        });
    }
    storage::save_settings(&dir, &s);
}

/// 快照当前可见的小组件窗口，供下次启动恢复
fn snapshot_open_widgets(app: &AppHandle) {
    let mut open = Vec::new();
    for (label, win) in app.webview_windows() {
        let Some(id) = label.strip_prefix("w-") else {
            continue;
        };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        let title = win.title().map(|t| t.to_string()).unwrap_or_default();
        open.push(storage::OpenWindow {
            id: id.to_string(),
            title,
        });
    }
    let dir = storage::data_dir(app);
    let mut s = storage::load_settings(&dir);
    s.open_windows = open;
    storage::save_settings(&dir, &s);
}

fn schedule_save(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut last = state.last_save.lock().unwrap();
    let due = last.map_or(true, |t| t.elapsed() > Duration::from_millis(800));
    if due {
        *last = Some(Instant::now());
        drop(last);
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            save_pos_now(&handle);
        });
    }
}

// ---------------- 基础设施（快捷启动组件使用） ----------------

#[tauri::command]
fn resolve_paths(paths: Vec<String>) -> Vec<links::Resolved> {
    paths.iter().filter_map(|p| links::resolve(p)).collect()
}

#[tauri::command]
async fn list_apps() -> Vec<links::Resolved> {
    tauri::async_runtime::spawn_blocking(links::collect_start_menu_apps)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn get_icon(app: AppHandle, path: String) -> String {
    icons::cached_icon(&app, &path).unwrap_or_default()
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        if target.trim().is_empty() {
            return Err("目标路径为空".into());
        }
        let wide: Vec<u16> = std::ffi::OsStr::new(&target)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let hinst = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(wide.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        let code = hinst.0 as isize;
        if code <= 32 {
            return Err(shell_open_error(code));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
fn shell_open_error(code: isize) -> String {
    let msg = match code {
        0 | 8 => "内存不足",
        2 => "文件不存在",
        3 => "路径不存在",
        5 => "拒绝访问",
        11 => "可执行文件无效或损坏",
        26 => "发生共享冲突",
        27 => "文件关联信息不完整",
        28 | 29 | 30 => "动态数据交换失败",
        31 => "没有与之关联的应用",
        32 => "缺少依赖组件",
        _ => "打开失败",
    };
    format!("{msg}（错误码 {code}）")
}

#[tauri::command]
fn reveal_target(target: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", target))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open").arg(&target).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enable {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
fn round_window_corners(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };

    let Ok(raw) = win.hwnd() else {
        return;
    };
    let hwnd = HWND(raw.0);
    let pref: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND;
    unsafe {
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const _,
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
        if hr.is_err() {
            eprintln!("corner preference failed: {:?}", hr);
        }
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = storage::data_dir(app.handle());
    storage::migrate(&dir);
    let settings = storage::load_settings(&dir);
    // 初始化固定窗口缓存：固定的窗口自动解除吸附
    {
        let state = app.state::<AppState>();
        let mut ps = state.pinned_set.lock().unwrap();
        for (lbl, wst) in &settings.windows {
            if wst.pinned {
                ps.insert(lbl.clone());
            }
        }
    }
    let win = app
        .get_webview_window("main")
        .ok_or("main window missing")?;

    #[cfg(target_os = "windows")]
    {
        apply_glass(&win, settings.global_glass());
        round_window_corners(&win);
    }

    let main_state = settings.window("main");
    if let (Some(x), Some(y)) = (main_state.x, main_state.y) {
        let (cx, cy) = clamp_fully_in_monitors(&win, x, y);
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
        app.state::<AppState>()
            .latest_pos
            .lock()
            .unwrap()
            .insert("main".into(), (cx, cy));
    } else if let Ok(pos) = win.outer_position() {
        app.state::<AppState>()
            .latest_pos
            .lock()
            .unwrap()
            .insert("main".into(), (pos.x, pos.y));
    }
    *app.state::<AppState>().glass_value.lock().unwrap() = settings.global_glass();
    *app.state::<AppState>().size_step.lock().unwrap() = settings.size_step();

    if let Ok(sz) = win.inner_size() {
        let scale = win.scale_factor().unwrap_or(1.0);
        app.state::<AppState>().latest_size.lock().unwrap().insert(
            "main".into(),
            (sz.width as f64 / scale, sz.height as f64 / scale),
        );
    }

    tauri::tray::TrayIconBuilder::with_id("tray")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/32x32.png"
        ))?)
        .tooltip("lildog-desk")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main_visible(app),
            "quit" => {
                save_pos_now(app);
                app.exit(0);
            }
            id => {
                if let Some(widget_id) = id.strip_prefix("w:") {
                    let state = app.state::<AppState>();
                    let entry = {
                        let items = state.tray_items.lock().unwrap().clone();
                        items.into_iter().find(|e| e.id == widget_id)
                    };
                    if let Some(e) = entry {
                        // 菜单事件在主线程回调，建窗必须离开主线程，否则死锁
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            let _ = toggle_widget_window_cmd(
                                &app2,
                                &e.id,
                                &e.title,
                                e.width,
                                e.height,
                            );
                        });
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_visible(tray.app_handle());
            }
        })
        .build(app)?;

    rebuild_tray_menu(app.handle(), &[])?;

    // 全局热键：截图(1) / 截图并贴图(2) / 呼出剪贴板面板(3)。
    // 首选被占用时沿候选链回退（例如 WPF 版剪贴板工具占用了 Ctrl+Alt+A）。
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
        let gs = app.handle().global_shortcut();
        let chains: [(&[&str], u8); 3] = [
            (&["ctrl+alt+a", "ctrl+alt+x", "ctrl+alt+c"], 1),
            (&["ctrl+alt+s", "ctrl+alt+d", "ctrl+alt+f"], 2),
            (&["ctrl+`", "ctrl+alt+p"], 3),
        ];
        let mut bound: Vec<String> = Vec::new();
        for (candidates, intent) in chains {
            for cand in candidates {
                let Ok(sc) = cand.parse::<Shortcut>() else {
                    continue;
                };
                match gs.register(sc.clone()) {
                    Ok(_) => {
                        app.state::<AppState>()
                            .hotkey_map
                            .lock()
                            .unwrap()
                            .push((sc, intent));
                        bound.push(format!("{cand}"));
                        break;
                    }
                    Err(_) => continue,
                }
            }
        }
        eprintln!("global hotkeys bound: {bound:?}");
    }

    // 吸附预览层：透明点击穿透悬浮窗，事件循环启动前创建避免死锁
    {
        let preview = WebviewWindowBuilder::new(
            app.handle(),
            "snap-preview",
            WebviewUrl::App("index.html".into()),
        )
        .title("snap-preview")
        .inner_size(120.0, 80.0)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .always_on_top(true)
        .focused(false)
        .build();
        if let Ok(pw) = preview {
            let _ = pw.set_ignore_cursor_events(true);
            #[cfg(target_os = "windows")]
            round_window_corners(&pw);
        }
    }

    // 恢复上次退出时仍打开的小组件（位置与尺寸由 windows 记忆提供）
    for ow in settings.open_windows.clone() {
        if !valid_widget_id(&ow.id) {
            continue;
        }
        let _ = ensure_widget_window(app.handle(), &ow.id, &ow.title, 300.0, 320.0);
    }

    Ok(())
}

fn toggle_widget_window_cmd(
    app: &AppHandle,
    widget_id: &str,
    title: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("w-{widget_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        if existing.is_visible().unwrap_or(false) {
            let _ = existing.hide();
            return Ok(());
        }
    }
    ensure_widget_window(app, widget_id, title, width, height)
}

fn toggle_main_visible(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[cfg(target_os = "windows")]
fn reapply_glass_async(app: &AppHandle, label: &str) {
    // 贴图窗/截图层不参与玻璃效果
    if is_chromeless_label(label) {
        return;
    }
    let glass = *app.state::<AppState>().glass_value.lock().unwrap();
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        apply_glass(&win.clone(), glass);
        std::thread::sleep(Duration::from_millis(340));
        apply_glass(&win, glass);
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let intent = app
                            .state::<AppState>()
                            .hotkey_map
                            .lock()
                            .unwrap()
                            .iter()
                            .find_map(|(s, i)| (s == shortcut).then_some(*i));
                        if let Some(intent) = intent {
                            let app = app.clone();
                            // 窗口操作离开事件回调线程，避免死锁
                            std::thread::spawn(move || match intent {
                                1 | 2 => {
                                    let _ = launch_shot(&app, intent);
                                }
                                3 => summon_clipboard_panel(&app),
                                _ => {}
                            });
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_widget_data,
            save_widget_data,
            get_window_state,
            set_text_stroke,
            set_size_step,
            set_theme,
            set_pinned,
            set_collapsed,
            set_bg_opacity,
            set_glass,
            open_widget_window,
            toggle_widget_window,
            close_widget_window,
            update_tray_widgets,
            fetch_json,
            resolve_opencode_key,
            resolve_paths,
            list_apps,
            get_icon,
            open_target,
            reveal_target,
            clipboard::read_clipboard_state,
            clipboard::write_clipboard_text,
            clipboard::write_clipboard_files,
            clipboard::write_clipboard_image,
            clipboard::delete_clipboard_image,
            clipboard::clip_image_data_url,
            clipboard::set_clip_dir,
            open_image_pin,
            take_pin_payload,
            start_shot,
            commit_shot_rect,
            cancel_shot,
            paste_to_last_target,
            get_autostart,
            set_autostart
        ])
        .setup(setup)
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(pos) => {
                let app = window.app_handle();
                let label = window.label().to_string();
                // 预览层与贴图窗不参与任何吸附逻辑，避免自反馈或干扰
                if is_chromeless_label(&label) {
                    return;
                }
                if let Some(win) = app.get_webview_window(&label) {
                    let (cx, cy) = clamp_fully_in_monitors(&win, pos.x, pos.y);
                    let state = app.state::<AppState>();
                    state
                        .latest_pos
                        .lock()
                        .unwrap()
                        .insert(label.clone(), (cx, cy));
                    start_release_watcher(app);

                    // 调节尺寸期间不做位置吸附预览
                    let resizing_active = {
                        let pend = state.resize_pending.lock().unwrap();
                        matches!(
                            pend.get(&label),
                            Some(p) if p.at.elapsed() <= Duration::from_millis(250)
                        )
                    };
                    // 固定（置顶）的窗口自动解除吸附
                    let pinned = state.pinned_set.lock().unwrap().contains(&label);
                    // 程序化改尺寸（折叠/展开）期间同样跳过吸附评估
                    let programmatic = is_programmatic_resize(&state, &label);

                    // 预览式吸附：拖动过程零干预，接近对齐位时只显示预览框，
                    // 松开鼠标左键后由监听线程统一落位
                    if pinned || resizing_active || programmatic {
                        state.pending_snap.lock().unwrap().remove(&label);
                        hide_preview_if_idle(app);
                    } else {
                        let ((tx, ty), engaged) = snap_position(&win, app, cx, cy);
                        if engaged && ((tx, ty) != (cx, cy)) {
                            state.pending_snap.lock().unwrap().insert(
                                label.clone(),
                                PendingSnap { x: tx, y: ty, at: Instant::now() },
                            );
                            if let Ok(sz) = win.outer_size() {
                                preview_show(
                                    app,
                                    tx,
                                    ty,
                                    sz.width as i32,
                                    sz.height as i32,
                                    PreviewMode::Snap,
                                );
                            }
                        } else {
                            state.pending_snap.lock().unwrap().remove(&label);
                            hide_preview_if_idle(app);
                        }
                    }
                }
                schedule_save(app);
            }
            WindowEvent::Resized(size) => {
                let app = window.app_handle();
                let label = window.label().to_string();
                // 预览层与贴图窗不参与阶梯吸附等逻辑
                if is_chromeless_label(&label) {
                    return;
                }
                let win = app.get_webview_window(&label);
                if let Some(ref w) = win {
                    clamp_size_into_monitors(w);
                }
                start_release_watcher(app);
                let scale = window.scale_factor().unwrap_or(1.0);
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                if lh > 100.0 && lw > 100.0 {
                    app.state::<AppState>()
                        .latest_size
                        .lock()
                        .unwrap()
                        .insert(label.clone(), (lw, lh));

                    let state = app.state::<AppState>();
                    // 程序化改尺寸（折叠/展开）不参与阶梯吸附，只记录尺寸
                    if !is_programmatic_resize(&state, &label) {
                    // 预览式尺寸阶梯：拖动过程零干预，实时显示量化目标预览框，
                    // 松开鼠标左键后由监听线程一次性落位
                    let step = *state.size_step.lock().unwrap();
                    // 记录本次调节手势的起点位置（用于判断拖动的是哪条边）
                    let start_pos = {
                        let mut pend = state.resize_pending.lock().unwrap();
                        let entry = pend.entry(label.clone()).or_insert_with(|| {
                            ResizeSession {
                                lw,
                                lh,
                                gen: 0,
                                at: Instant::now(),
                                start_pos: window
                                    .outer_position()
                                    .map(|p| (p.x, p.y))
                                    .ok(),
                            }
                        });
                        entry.lw = lw;
                        entry.lh = lh;
                        entry.at = Instant::now();
                        entry.gen += 1;
                        entry.start_pos
                    };
                    if let Some(w) = &win {
                        // 固定（置顶）的窗口自动解除尺寸吸附
                        let pinned = state.pinned_set.lock().unwrap().contains(&label);
                        if pinned {
                            state.pending_resize.lock().unwrap().remove(&label);
                            hide_preview_if_idle(app);
                        } else if let (Ok(cur), Ok(pos)) =
                            (w.outer_size(), w.outer_position())
                        {
                            let cw = cur.width as f64 / scale;
                            let ch = cur.height as f64 / scale;
                            let qw = quantize_logical(cw, step, 160.0);
                            let qh = quantize_logical(ch, step, 96.0);
                            let dw = ((qw - cw) * scale).round() as i32;
                            let dh = ((qh - ch) * scale).round() as i32;
                            if dw != 0 || dh != 0 {
                                // 锚定未拖动的边：调节期间位置变化的轴说明拖的是左/上边，
                                // 落位时保持右/下边不动；未变的轴默认锚定左上。
                                let new_w = (cur.width as i32 + dw).max(1);
                                let new_h = (cur.height as i32 + dh).max(1);
                                let mut px = pos.x;
                                let mut py = pos.y;
                                if let Some((sx, sy)) = start_pos {
                                    if pos.x != sx {
                                        px = pos.x + cur.width as i32 - new_w;
                                    }
                                    if pos.y != sy {
                                        py = pos.y + cur.height as i32 - new_h;
                                    }
                                }
                                // 显示大小预览框（绿色实线）；吸附预览框不参与
                                state.pending_resize.lock().unwrap().insert(
                                    label.clone(),
                                    PendingResize {
                                        w: new_w as u32,
                                        h: new_h as u32,
                                        x: px,
                                        y: py,
                                        at: Instant::now(),
                                    },
                                );
                                preview_show(
                                    app,
                                    px,
                                    py,
                                    new_w,
                                    new_h,
                                    PreviewMode::Size,
                                );
                            } else {
                                state.pending_resize.lock().unwrap().remove(&label);
                                hide_preview_if_idle(app);
                            }
                        }
                    }
                    }
                }
                schedule_save(app);
            }
            WindowEvent::Focused(_) => {
                #[cfg(target_os = "windows")]
                reapply_glass_async(window.app_handle(), window.label());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build lildog-desk");

    app.run(|_app, _event| {
        if matches!(_event, RunEvent::Exit) {
            save_pos_now(_app);
            snapshot_open_widgets(_app);
        }
    });
}

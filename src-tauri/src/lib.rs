mod icons;
mod links;
mod storage;

use std::collections::HashMap;
use std::fs;
use std::process::Command;
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
    /// 已触发吸附并处于锁定态的窗口：label -> 吸附落点。
    /// 锁定期间若目标不变则完全跟手，目标变化或消失时立即更新/解锁。
    snap_locks: Mutex<HashMap<String, (i32, i32)>>,
    /// 去抖中的尺寸调节：label -> 会话
    resize_pending: Mutex<HashMap<String, ResizeSession>>,
    glass_value: Mutex<f64>,
    size_step: Mutex<u32>,
    tray_items: Mutex<Vec<TrayEntry>>,
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
    }))
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
    {
        let st = s.windows.entry(label.clone()).or_default();
        if collapsed {
            if let Ok(size) = win.inner_size() {
                let scale = win.scale_factor().unwrap_or(1.0);
                st.width = Some(size.width as f64 / scale);
                st.height = Some(size.height as f64 / scale);
            }
            win.set_size(LogicalSize::new(st.width.unwrap_or(340.0), 72.0))
                .map_err(|e| e.to_string())?;
        } else {
            win.set_size(LogicalSize::new(
                st.width.unwrap_or(340.0),
                st.height.unwrap_or(560.0),
            ))
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
    // 全局统一：应用到当前所有窗口
    for (_, win) in app.webview_windows() {
        #[cfg(target_os = "windows")]
        apply_glass(&win, v);
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
    // 新建窗口前清掉历史吸附锁，避免沿用旧位置的锁定态
    app.state::<AppState>()
        .snap_locks
        .lock()
        .unwrap()
        .remove(&label);

    let dir = storage::data_dir(app);
    let settings = storage::load_settings(&dir);
    let st = settings.window(&label);
    let glass = settings.global_glass();
    let step = *app.state::<AppState>().size_step.lock().unwrap();
    let w = quantize_logical(st.width.unwrap_or(width).max(160.0), step, 160.0);
    let h = quantize_logical(st.height.unwrap_or(height).max(96.0), step, 96.0);

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

/// 将逻辑尺寸量化到步进的整数倍，便于组件窗口对齐拼接
fn quantize_logical(v: f64, step: u32, min: f64) -> f64 {
    if step < 4 {
        return v.max(min);
    }
    let s = step as f64;
    ((v / s).round() * s).max(min)
}

/// 磁性吸附：拖动时窗口边缘贴近其他可见窗口或屏幕边缘则自动贴合。
/// 窗口之间允许重叠；除首尾拼接外，还支持同边对齐（左/右/上/下）。
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
    let mut l = x;
    let mut r = x + w;
    let mut t = y;
    let mut b = y + h;
    let mut engaged = false;

    // 与其他可见窗口吸附
    for (label, other) in app.webview_windows() {
        if label == win.label() || !other.is_visible().unwrap_or(false) {
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
            // 水平方向所有对齐方式独立评估，取距离最近者（支持多侧）
            let cands = [
                (or_, (l - or_).abs()),         // 我左缘 ↔ 对方右缘拼接
                (ol - w, (r - ol).abs()),       // 我右缘 ↔ 对方左缘拼接
                (ol, (l - ol).abs()),           // 左缘与对方左缘对齐
                (or_ - w, (r - or_).abs()),     // 右缘与对方右缘对齐
            ];
            if let Some(&(_, nl)) = cands
                .iter()
                .filter(|(_, d)| *d <= th)
                .min_by_key(|(_, d)| *d)
            {
                engaged = true;
                l = nl;
                r = l + w;
            }
        }
        let h_near = l < or_ + th && r > ol - th;
        if h_near {
            // 垂直方向同样独立评估，取最近者
            let cands = [
                (ob, (t - ob).abs()),           // 我上缘 ↔ 对方下缘拼接
                (ot - h, (b - ot).abs()),       // 我下缘 ↔ 对方上缘拼接
                (ot, (t - ot).abs()),           // 上缘对齐
                (ob - h, (b - ob).abs()),       // 下缘对齐
            ];
            if let Some((_, nt)) = cands
                .iter()
                .filter(|(_, d)| *d <= th)
                .min_by_key(|(_, d)| *d)
            {
                engaged = true;
                t = *nt;
                b = t + h;
            }
        }
    }

    // 与屏幕边缘吸附
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let mp = m.position();
            let ms = m.size();
            let ml = mp.x;
            let mr = mp.x + ms.width as i32;
            let mt = mp.y;
            let mb = mp.y + ms.height as i32;

            // 「接近」而非严格重叠，与窗口间对齐保持一致
            let v_near = t < mb + th && b > mt - th;
            if v_near {
                let cands = [
                    (ml, (l - ml).abs()),
                    (mr - w, (r - mr).abs()),
                ];
                if let Some(&(_, nl)) = cands
                    .iter()
                    .filter(|(_, d)| *d <= th)
                    .min_by_key(|(_, d)| *d)
                {
                    engaged = true;
                    l = nl;
                    r = nl + w;
                }
            }
            let h_near = l < mr + th && r > ml - th;
            if h_near {
                let cands = [
                    (mt, (t - mt).abs()),
                    (mb - h, (b - mb).abs()),
                ];
                if let Some(&(_, nt)) = cands
                    .iter()
                    .filter(|(_, d)| *d <= th)
                    .min_by_key(|(_, d)| *d)
                {
                    engaged = true;
                    t = nt;
                    b = nt + h;
                }
            }
        }
    }

    ((l, t), engaged)
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
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_widget_data,
            save_widget_data,
            get_window_state,
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
            get_autostart,
            set_autostart
        ])
        .setup(setup)
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(pos) => {
                let app = window.app_handle();
                let label = window.label().to_string();
                if let Some(win) = app.get_webview_window(&label) {
                    let (cx, cy) = clamp_fully_in_monitors(&win, pos.x, pos.y);
                    let state = app.state::<AppState>();
                    let mut latest = state.latest_pos.lock().unwrap();
                    let mut locks = state.snap_locks.lock().unwrap();

                    // 调节大小时禁用吸附：尺寸调节常伴随 Moved 事件，此时不参与位置吸附
                    let resizing_active = {
                        let pend = state.resize_pending.lock().unwrap();
                        matches!(
                            pend.get(&label),
                            Some(p) if p.at.elapsed() <= Duration::from_millis(220)
                        )
                    };

                    let final_pos = if resizing_active {
                        locks.remove(&label);
                        (cx, cy)
                    } else {
                        // 每次移动都重新评估吸附：
                        // · 感应区内无目标 → 解锁，完全跟手
                        // · 有目标且与锁定相同（含已落在目标上）→ 跟手不拉扯
                        // · 有目标但不同于锁定 → 立即跳到新目标
                        let ((sx, sy), engaged) = snap_position(&win, app, cx, cy);
                        if !engaged {
                            locks.remove(&label);
                            (cx, cy)
                        } else {
                            let same_as_lock =
                                matches!(locks.get(&label), Some(o) if *o == (sx, sy));
                            locks.insert(label.clone(), (sx, sy));
                            if same_as_lock || (sx, sy) == (cx, cy) {
                                (cx, cy)
                            } else {
                                (sx, sy)
                            }
                        }
                    };
                    if final_pos.0 != pos.x || final_pos.1 != pos.y {
                        let _ =
                            win.set_position(PhysicalPosition::new(final_pos.0, final_pos.1));
                    }
                    latest.insert(label.clone(), final_pos);
                }
                schedule_save(app);
            }
            WindowEvent::Resized(size) => {
                let app = window.app_handle();
                let label = window.label().to_string();
                if let Some(win) = app.get_webview_window(&label) {
                    clamp_size_into_monitors(&win);
                }
                let scale = window.scale_factor().unwrap_or(1.0);
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                if lh > 100.0 && lw > 100.0 {
                    app.state::<AppState>()
                        .latest_size
                        .lock()
                        .unwrap()
                        .insert(label.clone(), (lw, lh));

                    // 尺寸阶梯去抖：拖动过程不干预窗口，停止约 160ms 后一次性吸附到步进，
                    // 避免拖拽中反复 set_size 造成的抖动
                    let state = app.state::<AppState>();
                    let step = *state.size_step.lock().unwrap();
                    let (gen, start_pos) = {
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
                        (entry.gen, entry.start_pos)
                    };
                    let app2 = app.clone();
                    let label2 = label.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(160));
                        let st = app2.state::<AppState>();
                        let fresh = {
                            let pend = st.resize_pending.lock().unwrap();
                            matches!(
                                pend.get(&label2),
                                Some(p) if p.gen == gen
                                    && p.at.elapsed() >= Duration::from_millis(150)
                            )
                        };
                        if !fresh {
                            return;
                        }
                        st.resize_pending.lock().unwrap().remove(&label2);
                        let Some(win) = app2.get_webview_window(&label2) else {
                            return;
                        };
                        let Ok(cur_phys) = win.outer_size() else {
                            return;
                        };
                        let Ok(pos_phys) = win.outer_position() else {
                            return;
                        };
                        let cscale = win.scale_factor().unwrap_or(1.0);
                        let cw = cur_phys.width as f64 / cscale;
                        let ch = cur_phys.height as f64 / cscale;
                        let qw = quantize_logical(cw, step, 160.0);
                        let qh = quantize_logical(ch, step, 96.0);
                        let dw = ((qw - cw) * cscale).round() as i32;
                        let dh = ((qh - ch) * cscale).round() as i32;
                        if dw == 0 && dh == 0 {
                            return;
                        }

                        // 锚定未拖动的边：调节期间位置发生变化的轴说明拖的是左/上边，
                        // 量化后保持右/下边不动；位置未变的轴默认锚定左上，无需补偿。
                        let new_w = (cur_phys.width as i32 + dw).max(1);
                        let new_h = (cur_phys.height as i32 + dh).max(1);
                        let mut np = pos_phys;
                        if let Some((sx, sy)) = start_pos {
                            if pos_phys.x != sx {
                                np.x = pos_phys.x + cur_phys.width as i32 - new_w;
                            }
                            if pos_phys.y != sy {
                                np.y = pos_phys.y + cur_phys.height as i32 - new_h;
                            }
                        }
                        let _ = win.set_size(tauri::PhysicalSize::new(
                            new_w as u32,
                            new_h as u32,
                        ));
                        if np != pos_phys {
                            let _ =
                                win.set_position(PhysicalPosition::new(np.x, np.y));
                        }
                    });
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

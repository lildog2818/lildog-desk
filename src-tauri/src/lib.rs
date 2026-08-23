mod icons;
mod links;
mod storage;

use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

#[derive(Default)]
struct AppState {
    last_save: Mutex<Option<Instant>>,
    latest_pos: Mutex<(i32, i32)>,
    latest_size: Mutex<(f64, f64)>,
    glass_value: Mutex<f64>,
}

#[tauri::command]
fn load_all(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = storage::data_dir(&app);
    let mut store = storage::load_store(&dir);
    if store.groups.is_empty() {
        store.groups.push(storage::Group {
            id: "g_default".into(),
            name: "常用".into(),
            color: "#ffb84d".into(),
            collapsed: false,
        });
    }
    Ok(serde_json::json!({
        "store": store,
        "settings": storage::load_settings(&dir),
    }))
}

#[tauri::command]
fn persist_store(app: AppHandle, store: storage::Store) -> Result<(), String> {
    storage::save_store(&storage::data_dir(&app), &store)
}

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
        Command::new("xdg-open").arg(&target).spawn().map(|_| ()).map_err(|e| e.to_string())
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
    use std::os::windows::process::CommandExt;
    Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", target))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_pinned(app: AppHandle, win: WebviewWindow, pin: bool) -> Result<(), String> {
    win.set_always_on_top(pin).map_err(|e| e.to_string())?;
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.pinned = pin;
    storage::save_settings(&dir, &s);
    Ok(())
}

#[tauri::command]
fn set_collapsed(
    app: AppHandle,
    win: WebviewWindow,
    collapsed: bool,
) -> Result<(), String> {
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    if collapsed {
        let size = win.inner_size().map_err(|e| e.to_string())?;
        let scale = win.scale_factor().unwrap_or(1.0);
        s.width = Some(size.width as f64 / scale);
        s.height = Some(size.height as f64 / scale);
        win.set_size(LogicalSize::new(s.width.unwrap_or(340.0), 72.0))
            .map_err(|e| e.to_string())?;
    } else {
        let h = s.height.unwrap_or(560.0);
        win.set_size(LogicalSize::new(s.width.unwrap_or(340.0), h))
            .map_err(|e| e.to_string())?;
    }
    s.collapsed = collapsed;
    storage::save_settings(&dir, &s);
    Ok(())
}

fn save_pos_now(app: &AppHandle) {
    let dir = storage::data_dir(app);
    let mut s = storage::load_settings(&dir);
    {
        let state = app.state::<AppState>();
        let (x, y) = *state.latest_pos.lock().unwrap();
        let (w, h) = *state.latest_size.lock().unwrap();
        s.x = Some(x);
        s.y = Some(y);
        if w > 0.0 && h > 0.0 {
            s.width = Some(w);
            s.height = Some(h);
        }
    }
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
        let ix = (pos.x + size.width as i32).min(mp.x + ms.width as i32) - pos.x.max(mp.x);
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

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = storage::data_dir(app.handle());
    let settings = storage::load_settings(&dir);
    let win = app
        .get_webview_window("main")
        .ok_or("main window missing")?;

    #[cfg(target_os = "windows")]
    {
        apply_glass(&win, settings.glass);
        round_window_corners(&win);
    }

    if let (Some(x), Some(y)) = (settings.x, settings.y) {
        let (cx, cy) = clamp_fully_in_monitors(&win, x, y);
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
        *app.state::<AppState>().latest_pos.lock().unwrap() = (cx, cy);
    } else if let Ok(pos) = win.outer_position() {
        *app.state::<AppState>().latest_pos.lock().unwrap() = (pos.x, pos.y);
    }
    *app.state::<AppState>().glass_value.lock().unwrap() = settings.glass.clamp(0.0, 1.0);

    if settings.collapsed {
        let _ = win.set_size(LogicalSize::new(settings.width.unwrap_or(340.0), 72.0));
    } else {
        let w = settings.width.unwrap_or(340.0);
        let h = settings.height.unwrap_or(560.0);
        let _ = win.set_size(LogicalSize::new(w, h));
    }

    if let Ok(sz) = win.inner_size() {
        let scale = win.scale_factor().unwrap_or(1.0);
        *app.state::<AppState>().latest_size.lock().unwrap() =
            (sz.width as f64 / scale, sz.height as f64 / scale);
    }
    if settings.pinned {
        let _ = win.set_always_on_top(true);
    }

    let show_item = MenuItem::with_id(app, "show", "显示 / 隐藏", true, None::<&str>)?;
    let pin_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &pin_item])?;

    tauri::tray::TrayIconBuilder::with_id("tray")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
        .tooltip("lildog-desk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_visible(app),
            "quit" => {
                save_pos_now(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_visible(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_visible(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn apply_bg_opacity(app: &AppHandle, v: f64) {
    let dir = storage::data_dir(app);
    let mut s = storage::load_settings(&dir);
    s.bg_opacity = v;
    storage::save_settings(&dir, &s);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("bg-opacity", v);
    }
}

#[tauri::command]
fn set_bg_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    apply_bg_opacity(&app, opacity.clamp(0.0, 1.0));
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

#[cfg(target_os = "windows")]
fn reapply_glass_async(app: &AppHandle) {
    let glass = *app.state::<AppState>().glass_value.lock().unwrap();
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        apply_glass(&win.clone(), glass);
        std::thread::sleep(Duration::from_millis(340));
        apply_glass(&win, glass);
    });
}

#[tauri::command]
fn set_glass(app: AppHandle, win: WebviewWindow, v: f64) -> Result<(), String> {
    let v = v.clamp(0.0, 1.0);
    #[cfg(target_os = "windows")]
    apply_glass(&win, v);
    *app.state::<AppState>().glass_value.lock().unwrap() = v;
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.glass = v;
    storage::save_settings(&dir, &s);
    Ok(())
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

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_all,
            persist_store,
            resolve_paths,
            list_apps,
            get_icon,
            open_target,
            reveal_target,
            set_pinned,
            set_collapsed,
            set_bg_opacity,
            set_glass,
            get_autostart,
            set_autostart
        ])
        .setup(setup)
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(pos) => {
                let app = window.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let (cx, cy) = clamp_fully_in_monitors(&win, pos.x, pos.y);
                    if cx != pos.x || cy != pos.y {
                        let _ = win.set_position(PhysicalPosition::new(cx, cy));
                    }
                    *app.state::<AppState>().latest_pos.lock().unwrap() = (cx, cy);
                }
                schedule_save(app);
            }
            WindowEvent::Resized(size) => {
                let app = window.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    clamp_size_into_monitors(&win);
                }
                let scale = window.scale_factor().unwrap_or(1.0);
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                if lh > 100.0 && lw > 100.0 {
                    *app.state::<AppState>().latest_size.lock().unwrap() = (lw, lh);
                }
                schedule_save(app);
            }
            WindowEvent::Focused(_) => {
                #[cfg(target_os = "windows")]
                reapply_glass_async(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build lildog-desk");

    app.run(|_app, _event| {
        if matches!(_event, RunEvent::Exit) {
            save_pos_now(_app);
        }
    });
}

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
async fn get_icon(app: AppHandle, path: String) -> String {
    icons::cached_icon(&app, &path).unwrap_or_default()
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    Command::new("explorer")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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

fn clamp_into_monitors(win: &WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let monitors = match win.available_monitors() {
        Ok(m) => m,
        Err(_) => return (x, y),
    };
    let wsize = win.outer_size().unwrap_or_default();
    let mut best = None;
    for m in &monitors {
        let pos = m.position();
        let size = m.size();
        let inside =
            x >= pos.x && y >= pos.y && x < pos.x + size.width as i32 && y < pos.y + size.height as i32;
        if inside {
            return (x, y);
        }
        let dist = (x - pos.x).abs() + (y - pos.y).abs();
        if best.map_or(true, |(d, _)| dist < d) {
            best = Some((dist, m));
        }
    }
    if let Some((_, m)) = best {
        let pos = m.position();
        let size = m.size();
        let max_x = pos.x + size.width as i32 - wsize.width as i32;
        let max_y = pos.y + size.height as i32 - wsize.height as i32;
        return (x.clamp(pos.x, max_x.max(pos.x)), y.clamp(pos.y, max_y.max(pos.y)));
    }
    (x, y)
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = storage::data_dir(app.handle());
    let settings = storage::load_settings(&dir);
    let win = app
        .get_webview_window("main")
        .ok_or("main window missing")?;

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_acrylic;
        if let Err(e) = apply_acrylic(&win, Some((18, 18, 24, 96))) {
            eprintln!("acrylic unavailable: {e}");
        }
        round_window_corners(&win);
    }

    if let (Some(x), Some(y)) = (settings.x, settings.y) {
        let (cx, cy) = clamp_into_monitors(&win, x, y);
        let _ = win.set_position(PhysicalPosition::new(cx, cy));
        *app.state::<AppState>().latest_pos.lock().unwrap() = (cx, cy);
    } else if let Ok(pos) = win.outer_position() {
        *app.state::<AppState>().latest_pos.lock().unwrap() = (pos.x, pos.y);
    }

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
            get_icon,
            open_target,
            reveal_target,
            set_pinned,
            set_collapsed,
            set_bg_opacity,
            get_autostart,
            set_autostart
        ])
        .setup(setup)
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(pos) => {
                let app = window.app_handle();
                *app.state::<AppState>().latest_pos.lock().unwrap() = (pos.x, pos.y);
                schedule_save(app);
            }
            WindowEvent::Resized(size) => {
                let app = window.app_handle();
                let scale = window.scale_factor().unwrap_or(1.0);
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                if lh > 100.0 && lw > 100.0 {
                    *app.state::<AppState>().latest_size.lock().unwrap() = (lw, lh);
                }
                schedule_save(app);
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

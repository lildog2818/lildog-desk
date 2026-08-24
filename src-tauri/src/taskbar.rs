//! 任务栏组件后端：枚举运行中窗口、激活/关闭窗口、
//! 停靠几何（主屏底部通栏）与系统任务栏（Shell_TrayWnd）显隐。
//!
//! 前端窗口 label 固定为 "w-taskbar"，复用既有 w-* 路由与能力白名单；
//! 几何不参与吸附/阶梯/位置记忆，由本模块的看门狗线程校正。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

/// 任务栏窗口 label（前端路由按 w- 前缀分派到小组件）
pub(crate) const LABEL: &str = "w-taskbar";
/// 无工作区预留条带时的默认高度（逻辑像素）
const TASKBAR_LOGICAL_H: f64 = 52.0;
/// 展开态总高度（逻辑像素，含底部条），需容纳选应用对话框
const FLYOUT_LOGICAL_H: f64 = 500.0;

static KEEPALIVE_STARTED: AtomicBool = AtomicBool::new(false);
/// 展开态（flyout）：向上扩出选应用/日历面板期间为 true，看门狗据此保持高度
static EXPANDED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskWindow {
    /// 窗口句柄（isize，前端原样传回）
    pub hwnd: isize,
    pub title: String,
    /// 进程可执行文件路径（取不到为空串）
    pub exe: String,
    pub minimized: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    pub windows: Vec<TaskWindow>,
    /// 当前前台窗口句柄（可能不在列表内，例如聚焦到本应用时）
    pub foreground: isize,
}

// ---------------- 运行中窗口枚举 ----------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{Duration, TaskList, TaskWindow};

    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Threading::{
        AttachThreadInput, OpenProcess, QueryFullProcessImageNameW, GetCurrentThreadId,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, FindWindowW, GetAncestor,
        GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW,
        SetForegroundWindow, ShowWindowAsync, GA_ROOT, GWL_EXSTYLE, SW_HIDE, SW_MINIMIZE,
        SW_RESTORE, SW_SHOW, WM_CLOSE, WS_EX_TOOLWINDOW,
    };

    struct EnumCtx {
        out: Vec<(isize, u32)>,
        self_pid: u32,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumCtx);

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == ctx.self_pid {
            return BOOL(1); // 排除自身进程的所有窗口（面板/贴图/任务栏…）
        }
        if GetAncestor(hwnd, GA_ROOT) != hwnd {
            return BOOL(1); // 只列顶层根窗口
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if (ex as u32) & WS_EX_TOOLWINDOW.0 != 0 {
            return BOOL(1);
        }
        let mut cloak = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloak as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if hr.is_ok() && cloak != 0 {
            return BOOL(1); // UWP 挂起的幽灵窗口
        }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut cls).max(0) as usize;
        let cls_name = String::from_utf16_lossy(&cls[..n.min(cls.len())]);
        if matches!(
            cls_name.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ) {
            return BOOL(1);
        }
        if GetWindowTextLengthW(hwnd) <= 0 {
            return BOOL(1);
        }

        ctx.out.push((hwnd.0 as isize, pid));
        BOOL(1)
    }

    pub(super) fn list_windows() -> TaskList {
        let mut ctx = EnumCtx {
            out: Vec::new(),
            self_pid: std::process::id(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM(&mut ctx as *mut EnumCtx as isize),
            );
        }

        let mut windows: Vec<TaskWindow> = Vec::with_capacity(ctx.out.len());
        for (hwnd_raw, pid) in ctx.out {
            let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
            let mut buf = [0u16; 512];
            let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
            if n <= 0 {
                continue;
            }
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            windows.push(TaskWindow {
                hwnd: hwnd_raw,
                title,
                exe: exe_of_pid(pid),
                minimized: unsafe { IsIconic(hwnd) }.as_bool(),
            });
        }
        windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

        let fg = unsafe { GetForegroundWindow() };
        TaskList {
            windows,
            foreground: fg.0 as isize,
        }
    }

    fn exe_of_pid(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            else {
                return String::new();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(handle);
            if ok && (len as usize) <= buf.len() {
                String::from_utf16_lossy(&buf[..len as usize])
            } else {
                String::new()
            }
        }
    }

    fn hwnd_from(val: isize) -> HWND {
        HWND(val as *mut core::ffi::c_void)
    }

    /// 激活/最小化/还原一个任务窗口：
    /// 最小化→还原；是前台→最小化；否则经 AttachThreadInput 序列切前台。
    pub(super) fn activate(hwnd_val: isize) {
        let hwnd = hwnd_from(hwnd_val);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindowAsync(hwnd, SW_RESTORE);
                std::thread::sleep(Duration::from_millis(60));
            }
            let fg = GetForegroundWindow();
            if fg == hwnd {
                let _ = ShowWindowAsync(hwnd, SW_MINIMIZE);
                return;
            }
            if !IsWindowVisible(hwnd).as_bool() {
                return; // 窗口已消失，忽略过期点击
            }
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let cur_thread = GetCurrentThreadId();
            let attached = fg_thread != 0 && fg_thread != cur_thread;
            if attached {
                let _ = AttachThreadInput(fg_thread, cur_thread, true);
            }
            let _ = BringWindowToTop(hwnd);
            let mut ok = SetForegroundWindow(hwnd).as_bool();
            if attached {
                let _ = AttachThreadInput(fg_thread, cur_thread, false);
            }
            if !ok {
                ok = SetForegroundWindow(hwnd).as_bool();
            }
            let _ = ok;
        }
    }

    pub(super) fn close(hwnd_val: isize) {
        unsafe {
            let _ = PostMessageW(
                Some(hwnd_from(hwnd_val)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }

    pub(super) fn minimize(hwnd_val: isize) {
        unsafe {
            let _ = ShowWindowAsync(hwnd_from(hwnd_val), SW_MINIMIZE);
        }
    }

    fn shell_tray_hwnd() -> Option<HWND> {
        let cls: Vec<u16> = "Shell_TrayWnd"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe { FindWindowW(PCWSTR(cls.as_ptr()), PCWSTR::null()).ok() }
    }

    pub(super) fn set_shell_tray_visible(visible: bool) {
        if let Some(h) = shell_tray_hwnd() {
            unsafe {
                let _ = ShowWindowAsync(h, if visible { SW_SHOW } else { SW_HIDE });
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::TaskList;

    pub(super) fn list_windows() -> TaskList {
        TaskList {
            windows: Vec::new(),
            foreground: 0,
        }
    }
    pub(super) fn activate(_hwnd: isize) {}
    pub(super) fn close(_hwnd: isize) {}
    pub(super) fn minimize(_hwnd: isize) {}
    pub(super) fn set_shell_tray_visible(_visible: bool) {}
}

pub(crate) fn list_windows() -> TaskList {
    imp::list_windows()
}

pub(crate) fn set_shell_tray_visible(visible: bool) {
    imp::set_shell_tray_visible(visible);
}

/// 无条件尝试恢复系统任务栏（幂等）：关闭任务栏悬浮窗与应用退出时调用，
/// 防止「我们的任务栏关了、系统任务栏还被藏着」导致桌面失去入口。
pub(crate) fn restore_shell_tray(_app: &AppHandle) {
    #[cfg(target_os = "windows")]
    imp::set_shell_tray_visible(true);
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub async fn list_task_windows() -> TaskList {
    list_windows()
}

#[tauri::command]
pub async fn activate_task_window(hwnd: isize) -> Result<(), String> {
    imp::activate(hwnd);
    Ok(())
}

#[tauri::command]
pub async fn close_task_window(hwnd: isize) -> Result<(), String> {
    imp::close(hwnd);
    Ok(())
}

#[tauri::command]
pub async fn minimize_task_window(hwnd: isize) -> Result<(), String> {
    imp::minimize(hwnd);
    Ok(())
}

#[tauri::command]
pub async fn get_hide_system_bar(app: AppHandle) -> bool {
    let dir = crate::storage::data_dir(&app);
    crate::storage::load_settings(&dir).taskbar_hide_system()
}

#[tauri::command]
pub async fn set_hide_system_bar(app: AppHandle, on: bool) -> Result<(), String> {
    let dir = crate::storage::data_dir(&app);
    let mut s = crate::storage::load_settings(&dir);
    s.taskbar_hide_system = Some(on);
    crate::storage::save_settings(&dir, &s);
    set_shell_tray_visible(!on);
    Ok(())
}

#[tauri::command]
pub async fn set_taskbar_expanded(
    app: AppHandle,
    expanded: bool,
) -> Result<(), String> {
    EXPANDED.store(expanded, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(LABEL) {
        place_now(&win);
    }
    Ok(())
}

/// 原生右键菜单：不受本窗口高度裁剪。菜单项 id 统一以 "tb-" 开头，
/// 点击事件由 lib.rs 的全局 on_menu_event 原样转发回 w-taskbar 分发。
#[tauri::command]
pub async fn show_tb_menu(
    app: AppHandle,
    win: tauri::WebviewWindow,
    kind: String,
    id: String,
    _title: String,
    hwnd: isize,
) -> Result<(), String> {
    use tauri::menu::{ContextMenu, IsMenuItem, Menu, MenuItem};

    let mk = |mid: String, label: &str| -> Result<MenuItem<tauri::Wry>, String> {
        MenuItem::with_id(&app, mid, label, true, None::<&str>)
            .map_err(|e| e.to_string())
    };

    let hide_sys =
        crate::storage::load_settings(&crate::storage::data_dir(&app)).taskbar_hide_system();

    let items: Vec<MenuItem<tauri::Wry>> = match kind.as_str() {
        "pin" => vec![
            mk(format!("tb-pin-open:{id}"), "打开")?,
            mk(format!("tb-pin-reveal:{id}"), "打开所在位置")?,
            mk(format!("tb-pin-unpin:{id}"), "从任务栏取消固定")?,
        ],
        "task" => vec![
            mk(format!("tb-task-min:{hwnd}"), "最小化")?,
            mk(format!("tb-task-close:{hwnd}"), "关闭窗口")?,
        ],
        _ => vec![
            mk("tb-bar-addpin".into(), "固定应用到任务栏…")?,
            mk(
                "tb-bar-togglesys".into(),
                if hide_sys { "显示系统任务栏" } else { "隐藏系统任务栏" },
            )?,
            mk("tb-bar-close".into(), "关闭任务栏")?,
        ],
    };

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        items.iter().map(|i| i as &dyn IsMenuItem<_>).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;

    // WebviewWindow 未暴露 get_window（需 unstable），经 AsRef<Webview> 拿 Window
    let window = win.as_ref().window();
    menu.popup(window).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- 停靠几何 ----------------

#[cfg(target_os = "windows")]
mod geom {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };

    /// 主显示器物理矩形：返回 ((左,上,右,下), (工作区 左,上,右,下))
    pub(super) fn primary_rects() -> Option<([i32; 4], [i32; 4])> {
        unsafe {
            let mon = MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY);
            let mut mi = MONITORINFO::default();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(mon, &mut mi).as_bool() {
                let r = &mi.rcMonitor;
                let w = &mi.rcWork;
                Some((
                    [r.left, r.top, r.right, r.bottom],
                    [w.left, w.top, w.right, w.bottom],
                ))
            } else {
                None
            }
        }
    }
}

/// 计算任务栏应处的物理矩形 (x, y, w, h)。
/// 有系统任务栏预留条带时精确填充该条带；否则用默认逻辑高度底边贴屏。
/// 展开态（flyout）下高度向上扩至 FLYOUT_LOGICAL_H，底边保持不动。
#[cfg(target_os = "windows")]
fn target_rect(scale: f64) -> (i32, i32, i32, i32) {
    if let Some((mon, work)) = geom::primary_rects() {
        let gap = mon[3] - work[3];
        let desired = (TASKBAR_LOGICAL_H * scale).round() as i32;
        let mut h = gap.max(desired).max(8);
        if EXPANDED.load(Ordering::SeqCst) {
            let fly = (FLYOUT_LOGICAL_H * scale).round() as i32;
            h = h.max(fly);
        }
        let w = (mon[2] - mon[0]).max(8);
        return (mon[0], mon[3] - h, w, h);
    }
    dock_fallback_rect(scale)
}

fn dock_fallback_rect(scale: f64) -> (i32, i32, i32, i32) {
    let logical = if EXPANDED.load(Ordering::SeqCst) {
        FLYOUT_LOGICAL_H
    } else {
        TASKBAR_LOGICAL_H
    };
    let h = ((logical * scale).round() as i32).max(8);
    (0, 0, 800, h)
}

/// 立即把窗口摆到目标矩形（仅在矩形不符时才动，避免无谓的事件风暴）
fn place_now(win: &tauri::WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    #[cfg(target_os = "windows")]
    {
        let (x, y, w, h) = target_rect(scale);
        set_rect(win, x, y, w, h);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows：主屏底部对齐 + 默认逻辑高度
        if let Ok(Some(mon)) = win.primary_monitor() {
            let mp = mon.position();
            let ms = mon.size();
            let (_, _, _, h) = dock_fallback_rect(scale);
            set_rect(win, mp.x, mp.y + ms.height as i32 - h, ms.width as i32, h);
        }
    }
}

/// 创建或复用任务栏窗口并落位显示（不抢焦点）。所有打开路径
/// （启动恢复/dashboard 卡片/托盘勾选）都经由 ensure_widget_window 特例进入此处。
pub(crate) fn ensure_taskbar_window(app: &AppHandle) -> Result<(), String> {
    // 每次打开都从停靠态开始（flyout 是前端会话内状态）
    EXPANDED.store(false, Ordering::SeqCst);
    let win = if let Some(existing) = app.get_webview_window(LABEL) {
        existing
    } else {
        let win = tauri::WebviewWindowBuilder::new(
            app,
            LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("任务栏")
        .inner_size(900.0, TASKBAR_LOGICAL_H)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .visible(false)
        .always_on_top(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;

        // 底部通栏不做圆角；玻璃效果与其他面板一致
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::Graphics::Dwm::{
                DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
                DWM_WINDOW_CORNER_PREFERENCE,
            };
            if let Ok(raw) = win.hwnd() {
                let pref: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND;
                unsafe {
                    let _ = DwmSetWindowAttribute(
                        HWND(raw.0),
                        DWMWA_WINDOW_CORNER_PREFERENCE,
                        &pref as *const _ as *const _,
                        std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                    );
                }
            }
            let glass = crate::storage::load_settings(&crate::storage::data_dir(app))
                .global_glass();
            crate::apply_glass(&win, glass);
        }

        win
    };

    place_now(&win);
    let _ = win.show();
    start_keeper(app);

    // 若设置要求隐藏系统任务栏，则保持隐藏状态一致
    #[cfg(target_os = "windows")]
    {
        let hide =
            crate::storage::load_settings(&crate::storage::data_dir(app)).taskbar_hide_system();
        imp::set_shell_tray_visible(!hide);
    }

    Ok(())
}

fn set_rect(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    let changed = match (win.outer_position(), win.outer_size()) {
        (Ok(pos), Ok(sz)) => pos.x != x || pos.y != y
            || sz.width as i32 != w
            || sz.height as i32 != h,
        _ => true,
    };
    if changed {
        let _ = win.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    // 看门狗每次路过都重申置顶，压过系统任务栏可能的 z 序回升
    let _ = win.set_always_on_top(true);
}

/// 看门狗：周期校正几何（分辨率/DPI 变化自愈）并重申置顶。
/// 窗口不可见时只跳过，不做任何窗口操作。
fn start_keeper(app: &AppHandle) {
    if KEEPALIVE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(2500));
        if let Some(win) = app.get_webview_window(LABEL) {
            if win.is_visible().unwrap_or(false) {
                place_now(&win);
            }
        }
    });
}

//! 任务栏组件后端：枚举运行中窗口、激活/最小化/关闭窗口、
//! 右键菜单（锚定在窗口矩形之外，防止菜单压在光标下被误点）。
//!
//! 任务栏本身是标准小组件窗口（label "w-taskbar"）：拖动/缩放/吸附/
//! 位置记忆全部复用通用 w-* 机制，本模块不做任何几何干预。

use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

/// 任务栏窗口 label（前端路由按 w- 前缀分派到小组件）
#[allow(dead_code)] // 面板定位（后续提交）会引用
pub(crate) const LABEL: &str = "w-taskbar";

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

// ---------------- 运行中窗口枚举与操作 ----------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{Duration, TaskList, TaskWindow};

    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Threading::{
        AttachThreadInput, OpenProcess, QueryFullProcessImageNameW, GetCurrentThreadId,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetAncestor,
        GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        PostMessageW, SetForegroundWindow, ShowWindowAsync, GA_ROOT, GWL_EXSTYLE,
        SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOOLWINDOW,
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

    /// 激活/还原一个任务窗口。左键始终只做前置激活（不做"前台再点=最小化"，
    /// 避免误触让窗口"消失"）；最小化走右键菜单。
    pub(super) fn activate(hwnd_val: isize) {
        let hwnd = hwnd_from(hwnd_val);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return; // 陈旧句柄：窗口已销毁
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindowAsync(hwnd, SW_RESTORE);
                std::thread::sleep(Duration::from_millis(60));
            }
            if !IsWindowVisible(hwnd).as_bool() {
                return;
            }
            let fg = GetForegroundWindow();
            if fg == hwnd {
                return; // 已是前台，无动作
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

    pub(super) fn minimize(hwnd_val: isize) {
        unsafe {
            let hwnd = hwnd_from(hwnd_val);
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = ShowWindowAsync(hwnd, SW_MINIMIZE);
            }
        }
    }

    pub(super) fn close(hwnd_val: isize) {
        unsafe {
            let hwnd = hwnd_from(hwnd_val);
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
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
    pub(super) fn minimize(_hwnd: isize) {}
    pub(super) fn close(_hwnd: isize) {}
}

pub(crate) fn list_windows() -> TaskList {
    imp::list_windows()
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
pub async fn minimize_task_window(hwnd: isize) -> Result<(), String> {
    imp::minimize(hwnd);
    Ok(())
}

#[tauri::command]
pub async fn close_task_window(hwnd: isize) -> Result<(), String> {
    imp::close(hwnd);
    Ok(())
}

/// 右键菜单：锚定在任务栏窗口矩形之外。
///
/// 修复"点击秒关闭"：muda 的 popup() 默认把菜单左上角对齐光标
/// （TPM_LEFTALIGN，第一项压在光标下），随后的普通左键会被菜单吞掉并
/// 选中光标下的项（如「关闭窗口」/「关闭任务栏」）。这里改用 popup_at，
/// 把菜单整体放到窗口上方（放不下则下方），光标在栏内时永不压住菜单项。
/// 注意 muda 对传入坐标做 ClientToScreen，因此这里给的是客户区坐标。
#[tauri::command]
pub async fn show_tb_menu(
    app: AppHandle,
    win: tauri::WebviewWindow,
    kind: String,
    id: String,
    _title: String,
    hwnd: isize,
    cx: f64,
    _cy: f64,
    pinned: bool,
) -> Result<(), String> {
    use tauri::menu::{ContextMenu, IsMenuItem, Menu, MenuItem};
    use tauri::{PhysicalPosition, Position};

    let mk = |mid: String, label: &str| -> Result<MenuItem<tauri::Wry>, String> {
        MenuItem::with_id(&app, mid, label, true, None::<&str>)
            .map_err(|e| e.to_string())
    };

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
                "tb-bar-pin-top".into(),
                if pinned { "取消置顶" } else { "钉住置顶" },
            )?,
            mk("tb-bar-close".into(), "关闭任务栏")?,
        ],
    };

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        items.iter().map(|i| i as &dyn IsMenuItem<_>).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;

    // 估算菜单尺寸（物理像素），把锚点放到窗口矩形外
    let scale = win.scale_factor().unwrap_or(1.0);
    let est_h = (items.len() as f64 * 34.0 + 12.0) * scale;
    let est_w = 220.0 * scale;
    let Ok(origin) = win.outer_position() else {
        return Err("无法获取任务栏位置".into());
    };
    let Ok(size) = win.outer_size() else {
        return Err("无法获取任务栏尺寸".into());
    };

    let mut ax = (cx * scale).round().max(0.0) as i32;
    ax = ax.clamp(8, (size.width as i32 - est_w as i32 - 8).max(8));
    // 上方放得下（窗口顶边离屏幕顶足够远）就放上方，否则放窗口下方
    let ay = if origin.y as f64 >= est_h + 8.0 {
        -est_h.round() as i32 - 6
    } else {
        size.height as i32 + 6
    };

    let window = win.as_ref().window();
    menu.popup_at(
        window,
        Position::Physical(PhysicalPosition::new(ax, ay)),
    )
    .map_err(|e| e.to_string())
}

/// 打开快捷设置面板（settings / picker 两种内容模式）。
/// 面板是独立置顶小窗，定位在任务栏上方右侧；失焦自动隐藏。
#[tauri::command]
pub async fn open_taskbar_panel(
    app: AppHandle,
    anchor: tauri::WebviewWindow,
    mode: String,
) -> Result<(), String> {
    crate::panel::open(&app, &anchor, &mode)
}

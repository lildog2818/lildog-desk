//! 原生任务栏外观替换：通过未公开但多年稳定的
//! `SetWindowCompositionAttribute(WCA_ACCENT_POLICY)` 接口改造 Explorer
//! 任务栏（主屏 Shell_TrayWnd、副屏 Shell_SecondaryTrayWnd）。
//!
//! 特性：
//! - 不注入 Explorer 进程、无需管理员权限，普通用户态跨进程生效；
//! - 效果与其他所有小组件完全一致：亚克力材质 + 应用主题背景色 +
//!   面板透明度，参数随全局外观（外观菜单）一起调节，没有独立配置；
//! - 生效位 = 持久化的 nativeBarOn 开关，由控制台「任务栏」卡片双击切换；
//! - 守护线程周期同步：覆盖 Explorer 重启、副屏热插、开关与主题变更；
//! - 记录每个句柄已应用的策略签名，签名不变时不重复调用（避免亚克力闪烁）；
//! - 只对本应用涂过的句柄做还原，不干扰 TranslucentTB 等其他美化工具；
//! - 应用退出时对所有已涂句柄发 ACCENT_DISABLED 还原系统默认。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{self, AppSettings};

// ---------------- ACCENT_POLICY FFI（未公开 API，动态解析） ----------------

const WCA_ACCENT_POLICY: u32 = 19;

const ACCENT_DISABLED: u32 = 0;
/// 亚克力（Win11 目标材质；与小组件窗口的玻璃效果同款）
const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;

/// ABGR：GradientColor = (a<<24) | (b<<16) | (g<<8) | r
#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: i32,
}

#[repr(C)]
struct WinCompAttribData {
    attrib: u32,
    data: *mut AccentPolicy,
    size_of_data: usize,
    unknown: i32,
}

fn disabled_policy() -> AccentPolicy {
    AccentPolicy {
        accent_state: ACCENT_DISABLED,
        accent_flags: 0,
        gradient_color: 0,
        animation_id: 0,
    }
}

fn parse_hex(s: &str) -> Option<(u8, u8, u8)> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(s, 16).ok()?;
    Some((((v >> 16) & 0xff) as u8, ((v >> 8) & 0xff) as u8, (v & 0xff) as u8))
}

// ---------------- 策略构造 ----------------

fn policy_signature(p: &AccentPolicy) -> u32 {
    p.accent_state ^ p.accent_flags ^ p.gradient_color ^ (p.animation_id as u32)
}

/// 从全局外观设置推导策略：色调取主题背景色（缺省 #282837），
/// 透明度取面板透明度，材质固定为亚克力 —— 与所有小组件窗口一致。
fn effect_policy(s: &AppSettings) -> AccentPolicy {
    let (r, g, b) = parse_hex(&s.bg_color()).unwrap_or((40, 40, 55));
    let a = (s.global_bg_opacity().clamp(0.0, 1.0) * 255.0).round().clamp(0.0, 255.0) as u32;
    AccentPolicy {
        accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
        accent_flags: 0,
        gradient_color: (a << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32,
        animation_id: 0,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        disabled_policy, policy_signature, AccentPolicy, WinCompAttribData, WCA_ACCENT_POLICY,
    };
    use std::collections::HashMap;
    use std::sync::OnceLock;

    use windows::core::{w, PCWSTR, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetClassNameW, IsWindow,
    };

    type SetWindowCompAttrFn =
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut WinCompAttribData) -> i32;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(libname: *const u16) -> *mut core::ffi::c_void;
        fn GetProcAddress(module: *mut core::ffi::c_void, procname: *const u8)
        -> *mut core::ffi::c_void;
    }

    /// 运行时解析 SetWindowCompositionAttribute：该 API 未公开，
    /// user32.dll 里存在但不在导入库中，静态链接会报 LNK2019
    /// （与 TranslucentTB 的 GetProcAddress 方案一致）。
    fn resolve_set_wca() -> Option<SetWindowCompAttrFn> {
        static FN: OnceLock<Option<SetWindowCompAttrFn>> = OnceLock::new();
        *FN.get_or_init(|| unsafe {
            const PROC: &[u8] = b"SetWindowCompositionAttribute\0";
            let module = GetModuleHandleW(w!("user32.dll").as_ptr());
            if module.is_null() {
                return None;
            }
            let proc = GetProcAddress(module, PROC.as_ptr());
            if proc.is_null() {
                return None;
            }
            Some(std::mem::transmute::<*mut core::ffi::c_void, SetWindowCompAttrFn>(proc))
        })
    }

    fn send_policy(hwnd: HWND, policy: &AccentPolicy) {
        let Some(set_wca) = resolve_set_wca() else {
            return; // 极老系统缺失该 API：静默跳过，功能不可用但不崩溃
        };
        let mut data = WinCompAttribData {
            attrib: WCA_ACCENT_POLICY,
            // 该 API 实际不修改策略结构，按惯例以可变指针传入
            data: policy as *const AccentPolicy as *mut AccentPolicy,
            size_of_data: std::mem::size_of::<AccentPolicy>(),
            unknown: 0,
        };
        unsafe {
            let _ = set_wca(hwnd.0, &mut data);
        }
    }

    /// 主栏 + 各副屏副栏句柄
    pub(super) fn find_bars() -> Vec<HWND> {
        let mut out = Vec::new();
        unsafe {
            if let Ok(main) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) {
                out.push(main);
            }
            struct Ctx {
                out: Vec<HWND>,
            }
            unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let ctx = &mut *(lparam.0 as *mut Ctx);
                let mut buf = [0u16; 64];
                let n = GetClassNameW(hwnd, &mut buf).max(0) as usize;
                let cls = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
                if cls == "Shell_SecondaryTrayWnd" {
                    ctx.out.push(hwnd);
                }
                BOOL(1)
            }
            let mut ctx = Ctx { out: Vec::new() };
            let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
            out.append(&mut ctx.out);
        }
        out
    }

    /// 把当前状态落到所有任务栏句柄上，返回新的「已涂句柄 -> 签名」表。
    /// 签名相同则跳过调用；仅还原本应用涂过的句柄。
    pub(super) fn sync_locked(
        active: bool,
        policy: &AccentPolicy,
        prev: &HashMap<isize, u32>,
    ) -> HashMap<isize, u32> {
        let mut next = HashMap::new();
        for hwnd in find_bars() {
            let key = hwnd.0 as isize;
            if active {
                let sig = policy_signature(policy);
                if prev.get(&key) != Some(&sig) {
                    send_policy(hwnd, policy);
                }
                next.insert(key, sig);
            } else if prev.contains_key(&key) {
                send_policy(hwnd, &disabled_policy());
            }
        }
        next
    }

    /// 退出兜底：对记录在案的句柄逐一还原（句柄失效则跳过）
    pub(super) fn restore(prev_keys: impl Iterator<Item = isize>) {
        for key in prev_keys {
            let hwnd = HWND(key as *mut core::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                send_policy(hwnd, &disabled_policy());
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::AccentPolicy;
    use std::collections::HashMap;

    pub(super) fn sync_locked(
        _active: bool,
        _policy: &AccentPolicy,
        prev: &HashMap<isize, u32>,
    ) -> HashMap<isize, u32> {
        prev.clone()
    }

    pub(super) fn restore(_prev_keys: impl Iterator<Item = isize>) {}
}

// ---------------- 应用层入口（命令 / 守护线程共用） ----------------

use crate::AppState;

/// 全量同步一次（幂等）：读开关缓存 + 全局外观设置，落策略到所有任务栏句柄。
/// 策略签名去重后，绝大多数轮次不会产生实际系统调用。
pub(crate) fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let active = *state.native_bar_on.lock().unwrap();
    let settings = storage::load_settings(&storage::data_dir(app));
    let policy = effect_policy(&settings);
    let mut painted = state.native_painted.lock().unwrap();
    *painted = imp::sync_locked(active, &policy, &painted);
}

/// 启动初始化：从设置载入开关缓存并拉起守护线程（每 4 秒一轮全量同步）
pub(crate) fn init(app: &AppHandle) {
    let dir = storage::data_dir(app);
    let on = storage::load_settings(&dir).native_bar_on();
    *app.state::<AppState>().native_bar_on.lock().unwrap() = on;
    sync(app);

    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        // 收敛四种变化源：Explorer 重启新句柄、副屏热插、开关变化、主题/透明度变更
        sync(&handle);
    });
}

/// 应用退出：还原所有已涂句柄
pub(crate) fn restore_all(app: &AppHandle) {
    let keys: Vec<isize> = app
        .state::<AppState>()
        .native_painted
        .lock()
        .unwrap()
        .keys()
        .copied()
        .collect();
    imp::restore(keys.into_iter());
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub async fn get_native_bar(app: AppHandle) -> bool {
    *app.state::<AppState>().native_bar_on.lock().unwrap()
}

/// 切换原生任务栏替换。参数不在此设置：效果永远跟随全局外观。
#[tauri::command]
pub async fn set_native_bar(app: AppHandle, enabled: bool) -> Result<(), String> {
    *app.state::<AppState>().native_bar_on.lock().unwrap() = enabled;
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.native_bar_on = Some(enabled);
    storage::save_settings(&dir, &s);
    sync(&app);
    // 广播给所有窗口：控制台卡片据此刷新应用状态显示
    let _ = app.emit("native-bar", enabled);
    Ok(())
}

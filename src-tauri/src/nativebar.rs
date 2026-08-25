//! 原生任务栏外观替换：通过未公开但多年稳定的
//! `SetWindowCompositionAttribute(WCA_ACCENT_POLICY)` 接口改造 Explorer
//! 任务栏（主屏 Shell_TrayWnd、副屏 Shell_SecondaryTrayWnd）的背景材质、
//! 色调与不透明度（TranslucentTB 同款原理）。
//!
//! 特性：
//! - 不注入 Explorer 进程、无需管理员权限，普通用户态跨进程生效；
//! - 生效位 = 「任务栏」开关卡窗口（w-taskbar）可见，即用户口中的
//!   「点击打开就风格替换、关闭就恢复原有任务栏」（挂钩见 lib.rs）；
//! - 守护线程周期同步：覆盖 Explorer 重启、副屏热插、卡片显隐、配置变更；
//! - 记录每个句柄已应用的策略签名，签名不变时不重复调用（避免亚克力闪烁）；
//! - 只对本应用涂过的句柄做还原，不干扰 TranslucentTB 等其他美化工具；
//! - 应用退出时对所有已涂句柄发 ACCENT_DISABLED 还原系统默认。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{self, NativeBarCfg};

// ---------------- ACCENT_POLICY FFI（未公开 API，动态解析） ----------------

const WCA_ACCENT_POLICY: u32 = 19;

const ACCENT_DISABLED: u32 = 0;
/// 纯色（不透明度接近 1 时即实心色块）
const ACCENT_ENABLE_GRADIENT: u32 = 1;
/// 全透明（保留边框投影，任务栏内容仍可见）
const ACCENT_ENABLE_TRANSPARENTGRADIENT: u32 = 2;
/// 高斯模糊
const ACCENT_ENABLE_BLURBEHIND: u32 = 3;
/// 亚克力（Win11 目标材质）
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

// ---------------- 配置 ----------------

impl NativeBarCfg {
    /// 合法性与范围收敛：未知模式回退 acrylic，opacity 夹到 0..1，
    /// 非法色值清空（回退主题色或默认底色）
    pub fn normalized(mut self) -> Self {
        if !matches!(self.mode.as_str(), "clear" | "blur" | "acrylic" | "solid") {
            self.mode = "acrylic".to_string();
        }
        self.opacity = self.opacity.clamp(0.0, 1.0);
        if let Some(t) = &self.tint {
            if parse_hex(t).is_none() {
                self.tint = None;
            }
        }
        self
    }

    /// 解析后的色调 RGB：follow_theme 时优先取主题背景色，
    /// 其次自定义色调，最后回退应用默认底色 #282837
    fn resolve_rgb(&self, theme_bg: Option<&str>) -> (u8, u8, u8) {
        let cand = if self.follow_theme {
            theme_bg.or(self.tint.as_deref())
        } else {
            self.tint.as_deref()
        };
        cand.and_then(parse_hex).unwrap_or((40, 40, 55))
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

fn policy_for(cfg: &NativeBarCfg, theme_bg: Option<&str>) -> AccentPolicy {
    let (r, g, b) = cfg.resolve_rgb(theme_bg);
    let a = (cfg.opacity * 255.0).round().clamp(0.0, 255.0) as u32;
    let color = (a << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32;
    let state = match cfg.mode.as_str() {
        "clear" => ACCENT_ENABLE_TRANSPARENTGRADIENT,
        "blur" => ACCENT_ENABLE_BLURBEHIND,
        "solid" => ACCENT_ENABLE_GRADIENT,
        _ => ACCENT_ENABLE_ACRYLICBLURBEHIND,
    };
    AccentPolicy {
        accent_state: state,
        accent_flags: 0,
        gradient_color: color,
        animation_id: 0,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        disabled_policy, policy_for, policy_signature, AccentPolicy, NativeBarCfg,
        WinCompAttribData, WCA_ACCENT_POLICY,
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
        cfg: Option<&NativeBarCfg>,
        theme_bg: Option<&str>,
        switch_on: bool,
        prev: &HashMap<isize, u32>,
    ) -> HashMap<isize, u32> {
        let mut next = HashMap::new();
        for hwnd in find_bars() {
            let key = hwnd.0 as isize;
            if switch_on {
                let policy = policy_for(cfg.unwrap_or(&NativeBarCfg::default()), theme_bg);
                let sig = policy_signature(&policy);
                if prev.get(&key) != Some(&sig) {
                    send_policy(hwnd, &policy);
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
    use super::{disabled_policy, NativeBarCfg};
    use std::collections::HashMap;

    pub(super) fn sync_locked(
        _cfg: Option<&NativeBarCfg>,
        _theme_bg: Option<&str>,
        _switch_on: bool,
        prev: &HashMap<isize, u32>,
    ) -> HashMap<isize, u32> {
        let _ = disabled_policy();
        HashMap::new()
    }

    pub(super) fn restore(_prev_keys: impl Iterator<Item = isize>) {}
}

// ---------------- 应用层入口（命令 / 窗口挂钩 / 守护线程共用） ----------------

use crate::AppState;

/// 「任务栏」开关卡窗口可见 = 用户要求替换处于开启位
fn switch_visible(app: &AppHandle) -> bool {
    app.get_webview_window("w-taskbar")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

fn theme_bg_if_following(cfg: &NativeBarCfg, app: &AppHandle) -> Option<String> {
    if !cfg.follow_theme {
        return None;
    }
    let dir = storage::data_dir(app);
    let c = storage::load_settings(&dir).bg_color();
    (!c.is_empty()).then_some(c)
}

/// 全量同步一次（幂等）：读缓存配置 + 卡片显隐位，落策略到所有任务栏句柄。
/// 策略签名去重后，绝大多数轮次不会产生实际系统调用。
pub(crate) fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.native_bar.lock().unwrap().clone();
    let theme_bg = cfg.as_ref().and_then(|c| theme_bg_if_following(c, app));
    let visible = switch_visible(app);
    let mut painted = state.native_painted.lock().unwrap();
    *painted = imp::sync_locked(cfg.as_ref(), theme_bg.as_deref(), visible, &painted);
}

/// 配置变化后调用：更新缓存并立即同步（set_native_bar / set_theme 共用）
pub(crate) fn apply_cfg(app: &AppHandle, cfg: NativeBarCfg) {
    *app.state::<AppState>().native_bar.lock().unwrap() = Some(cfg.normalized());
    sync(app);
}

/// 启动初始化：从设置载入缓存并拉起守护线程（每 4 秒一轮全量同步）
pub(crate) fn init(app: &AppHandle) {
    let dir = storage::data_dir(app);
    let cfg = storage::load_settings(&dir).native_bar;
    *app.state::<AppState>().native_bar.lock().unwrap() = cfg;
    sync(app);

    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        // 收敛四种变化源：Explorer 重启新句柄、副屏热插、卡片显隐、配置变更
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
pub async fn get_native_bar(app: AppHandle) -> NativeBarCfg {
    app.state::<AppState>()
        .native_bar
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn set_native_bar(app: AppHandle, cfg: NativeBarCfg) -> Result<(), String> {
    let cfg = cfg.normalized();
    let dir = storage::data_dir(&app);
    let mut s = storage::load_settings(&dir);
    s.native_bar = Some(cfg.clone());
    storage::save_settings(&dir, &s);
    apply_cfg(&app, cfg.clone());
    // 广播给所有窗口：「任务栏」开关卡据此实时刷新显示
    let _ = app.emit("native-bar", cfg);
    Ok(())
}

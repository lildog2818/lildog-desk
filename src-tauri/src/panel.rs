//! 快捷设置面板：独立置顶小窗（label "taskbar-panel"），
//! 承载 settings（音量/网络/磁贴）与 picker（选应用固定）两种内容模式。
//!
//! 定位在任务栏窗口上方右侧（放不下则下方），失焦由 lib.rs 隐藏。
//! 内容模式用"待取载荷 + 事件加速"双通道，避免首次创建时 emit 早于
//! 前端监听的竞态（与贴图窗 take_pin_payload 同思路）。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub(crate) const PANEL_LABEL: &str = "taskbar-panel";
const PANEL_LOGICAL_W: f64 = 340.0;
const PANEL_LOGICAL_H: f64 = 500.0;

static PENDING_MODE: Mutex<Option<String>> = Mutex::new(None);

/// 打开（或复用并重新定位）面板。anchor 为任务栏窗口。
pub(crate) fn open(
    app: &AppHandle,
    anchor: &tauri::WebviewWindow,
    mode: &str,
) -> Result<(), String> {
    *PENDING_MODE
        .lock()
        .map_err(|_| "面板状态锁失败".to_string())? = Some(mode.to_string());

    let panel = if let Some(existing) = app.get_webview_window(PANEL_LABEL) {
        existing
    } else {
        WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
            .title("快捷设置")
            .inner_size(PANEL_LOGICAL_W, PANEL_LOGICAL_H)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?
    };

    // 定位：任务栏上方右侧，放不下则下方；再 clamp 进锚点所在显示器
    let scale = anchor.scale_factor().unwrap_or(1.0);
    let ao = anchor.outer_position().map_err(|e| e.to_string())?;
    let asz = anchor.outer_size().map_err(|e| e.to_string())?;
    let (mut pw, mut ph) = ((PANEL_LOGICAL_W * scale) as i32, (PANEL_LOGICAL_H * scale) as i32);
    if let Ok(psz) = panel.outer_size() {
        pw = psz.width as i32;
        ph = psz.height as i32;
    }
    let gap = (8.0 * scale).round() as i32;
    let mut x = ao.x + asz.width as i32 - pw;
    let mut y = ao.y - ph - gap;
    if let Ok(Some(mon)) = anchor.current_monitor() {
        let mp = mon.position();
        let ms = mon.size();
        x = x.clamp(mp.x, (mp.x + ms.width as i32 - pw).max(mp.x));
        if y < mp.y {
            y = (ao.y + asz.height as i32 + gap).min(mp.y + ms.height as i32 - ph);
        }
        y = y.max(mp.y);
    }
    let _ = panel.set_position(PhysicalPosition::new(x, y));

    // 事件仅作加速路径；首次打开由前端 take_panel_mode 拉取兜底
    let _ = app.emit_to(PANEL_LABEL, "panel-mode", mode.to_string());
    let _ = panel.show();
    let _ = panel.set_focus();
    Ok(())
}

/// 面板前端就绪后拉取本次内容模式（无待取项则默认 settings）
#[tauri::command]
pub async fn take_panel_mode() -> String {
    PENDING_MODE
        .lock()
        .map(|mut m| m.take().unwrap_or_else(|| "settings".to_string()))
        .unwrap_or_else(|_| "settings".to_string())
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

fn default_bg_opacity() -> f64 {
    0.55
}

fn default_glass() -> f64 {
    0.376
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WinState {
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default = "default_bg_opacity")]
    pub bg_opacity: f64,
    #[serde(default = "default_glass")]
    pub glass: f64,
}

impl Default for WinState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: None,
            height: None,
            pinned: false,
            collapsed: false,
            bg_opacity: default_bg_opacity(),
            glass: default_glass(),
        }
    }
}

/// 退出时仍打开的小组件，用于下次启动恢复
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub bg_opacity: Option<f64>,
    #[serde(default)]
    pub glass: Option<f64>,
    #[serde(default)]
    pub size_step: Option<u32>,
    #[serde(default)]
    pub open_windows: Vec<OpenWindow>,
    /// 主题：主字体色（#rrggbb，None=默认）
    #[serde(default)]
    pub text_main: Option<String>,
    /// 主题：小字体色
    #[serde(default)]
    pub text_dim: Option<String>,
    /// 主题：背景色
    #[serde(default)]
    pub bg_color: Option<String>,
    #[serde(default)]
    pub windows: HashMap<String, WinState>,
}

impl AppSettings {
    pub fn text_main(&self) -> String {
        self.text_main.clone().unwrap_or_default()
    }

    pub fn text_dim(&self) -> String {
        self.text_dim.clone().unwrap_or_default()
    }

    pub fn bg_color(&self) -> String {
        self.bg_color.clone().unwrap_or_default()
    }
    pub fn window(&self, label: &str) -> WinState {
        self.windows.get(label).cloned().unwrap_or_default()
    }

    pub fn global_bg_opacity(&self) -> f64 {
        self.bg_opacity.unwrap_or_else(default_bg_opacity)
    }

    pub fn global_glass(&self) -> f64 {
        self.glass.unwrap_or_else(default_glass)
    }

    pub fn size_step(&self) -> u32 {
        self.size_step.unwrap_or(48).clamp(8, 200)
    }

    pub fn update_window<F: FnOnce(&mut WinState)>(&mut self, label: &str, f: F) {
        let st = self.windows.entry(label.to_string()).or_default();
        f(st);
    }
}

pub fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, fallback: T) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(fallback)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load_settings(dir: &Path) -> AppSettings {
    read_json(&settings_path(dir), AppSettings::default())
}

pub fn save_settings(dir: &Path, s: &AppSettings) {
    let _ = write_json(&settings_path(dir), s);
}

/// 仅允许安全的组件 id，防止路径穿越
fn sanitize_widget_id(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Some(id.to_string())
    } else {
        None
    }
}

pub fn widget_data_path(dir: &Path, widget_id: &str) -> Option<PathBuf> {
    let id = sanitize_widget_id(widget_id)?;
    Some(dir.join("widgets").join(id).join("data.json"))
}

/// 返回 None 表示尚无数据（前端使用默认值）
pub fn load_widget_data(dir: &Path, widget_id: &str) -> Option<Value> {
    let path = widget_data_path(dir, widget_id)?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_widget_data(
    dir: &Path,
    widget_id: &str,
    value: &Value,
) -> Result<(), String> {
    let path = widget_data_path(dir, widget_id)
        .ok_or_else(|| "非法的组件 id".to_string())?;
    write_json(&path, value)
}

const LEGACY_KEYS: [&str; 8] = [
    "x",
    "y",
    "width",
    "height",
    "pinned",
    "collapsed",
    "bgOpacity",
    "glass",
];

/// 旧版本升级迁移：
/// 1. settings.json 扁平字段 → windows["w-launcher"] / windows["main"]
/// 2. 根目录 data.json → widgets/launcher/data.json
/// 全部幂等：已迁移过则跳过。
pub fn migrate(dir: &Path) {
    migrate_settings(dir);
    migrate_store(dir);
}

fn migrate_settings(dir: &Path) {
    let sp = settings_path(dir);
    let Ok(text) = fs::read_to_string(&sp) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if v.get("windows").is_some() {
        return;
    }
    let Some(obj) = v.as_object_mut() else {
        return;
    };

    let mut launcher = serde_json::Map::new();
    for k in LEGACY_KEYS {
        if let Some(val) = obj.remove(k) {
            launcher.insert(k.to_string(), val);
        }
    }
    let mut windows = serde_json::Map::new();
    windows.insert("w-launcher".into(), Value::Object(launcher));
    windows.insert("main".into(), serde_json::json!({}));
    obj.insert("windows".into(), Value::Object(windows));

    let _ = write_json(&sp, &v);
}

fn migrate_store(dir: &Path) {
    let old = dir.join("data.json");
    if !old.exists() {
        return;
    }
    match widget_data_path(dir, "launcher") {
        Some(new_path) if !new_path.exists() => {
            if write_json(&new_path, &read_json(&old, Value::Null)).is_ok() {
                let _ = fs::remove_file(&old);
            }
        }
        _ => {
            let _ = fs::remove_file(&old);
        }
    }
}

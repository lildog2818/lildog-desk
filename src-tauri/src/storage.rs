use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub args: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub group_id: String,
    #[serde(default)]
    pub order: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub collapsed: bool,
}

fn default_color() -> String {
    "#ffb84d".into()
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WinSettings {
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default = "default_bg_opacity")]
    pub bg_opacity: f64,
    #[serde(default = "default_glass")]
    pub glass: f64,
}

fn default_bg_opacity() -> f64 {
    0.55
}

fn default_glass() -> f64 {
    0.376
}

impl Default for WinSettings {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            pinned: false,
            collapsed: false,
        width: None,
        height: None,
        bg_opacity: 0.55,
        glass: 0.376,
    }
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

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let body =
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn store_path(dir: &Path) -> PathBuf {
    dir.join("data.json")
}

pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load_store(dir: &Path) -> Store {
    read_json(&store_path(dir), Store::default())
}

pub fn save_store(dir: &Path, store: &Store) -> Result<(), String> {
    write_json(&store_path(dir), store)
}

pub fn load_settings(dir: &Path) -> WinSettings {
    read_json(&settings_path(dir), WinSettings::default())
}

pub fn save_settings(dir: &Path, s: &WinSettings) {
    let _ = write_json(&settings_path(dir), s);
}

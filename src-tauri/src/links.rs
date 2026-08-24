use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub kind: String,
    pub name: String,
    pub target: String,
    pub args: Option<String>,
}

pub fn resolve(raw: &str) -> Option<Resolved> {
    let path = Path::new(raw);
    if !path.exists() {
        return None;
    }
    if path.is_dir() {
        return Some(Resolved {
            kind: "folder".into(),
            name: file_label(path),
            target: raw.to_string(),
            args: None,
        });
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "lnk" => resolve_lnk(path, raw),
        "url" => Some(Resolved {
            kind: "url".into(),
            name: file_label(path),
            target: raw.to_string(),
            args: None,
        }),
        _ => Some(Resolved {
            kind: "file".into(),
            name: file_label(path),
            target: raw.to_string(),
            args: None,
        }),
    }
}

fn file_label(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_else(|| path.file_name().unwrap_or_default())
        .to_string_lossy()
        .into_owned()
}

fn resolve_lnk(path: &Path, raw: &str) -> Option<Resolved> {
    let lnk = parselnk::Lnk::try_from(path).ok();
    let mut args = None;
    let mut kind = "app".to_string();

    if let Some(l) = &lnk {
        args = l
            .string_data
            .command_line_arguments
            .clone()
            .filter(|s| !s.trim().is_empty());
        if let Some(target) = lnk_target(l, path) {
            if Path::new(&target).is_dir() {
                kind = "folder".into();
            }
        }
    }

    Some(Resolved {
        kind,
        name: file_label(path),
        target: raw.to_string(),
        args,
    })
}

fn lnk_target(lnk: &parselnk::Lnk, path: &Path) -> Option<String> {
    inner_target(
        lnk.link_info
            .local_base_path
            .clone()
            .filter(|s| !s.is_empty()),
        lnk.link_info.common_path_suffix.clone(),
        lnk.string_data.relative_path.clone(),
        path,
    )
}

/// 从 lnk 解析信息中提取实际目标路径；供任务栏固定项解析运行态 exe 使用
pub(crate) fn inner_target(
    local_base_path: Option<String>,
    common_path_suffix: Option<String>,
    relative_path: Option<PathBuf>,
    path: &Path,
) -> Option<String> {
    if let Some(base) = local_base_path {
        let suffix = common_path_suffix
            .unwrap_or_default()
            .trim_start_matches('\\')
            .to_string();
        let joined = if suffix.is_empty() {
            base
        } else {
            format!("{}\\{}", base.trim_end_matches('\\'), suffix)
        };
        if !joined.is_empty() && Path::new(&joined).exists() {
            return Some(joined);
        }
    }
    if let Some(rel) = &relative_path {
        if let Some(parent) = path.parent() {
            let joined = parent.join(rel);
            if joined.exists() {
                return joined.to_string_lossy().into_owned().into();
            }
        }
    }
    None
}

const JUNK_MARKERS: [&str; 3] = ["uninstall", "uninst", "卸载"];

pub fn collect_start_menu_apps() -> Vec<Resolved> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(p)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs"));
    }
    if let Some(p) = std::env::var_os("PROGRAMDATA") {
        dirs.push(PathBuf::from(p)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs"));
    }

    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut seen_targets: HashSet<String> = HashSet::new();
    let mut out: Vec<Resolved> = Vec::new();
    for dir in dirs {
        if dir.is_dir() {
            collect_lnk_dir(&dir, 0, &mut seen_paths, &mut seen_targets, &mut out);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn collect_lnk_dir(
    dir: &Path,
    depth: usize,
    seen_paths: &mut HashSet<String>,
    seen_targets: &mut HashSet<String>,
    out: &mut Vec<Resolved>,
) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lnk_dir(&path, depth + 1, seen_paths, seen_targets, out);
            continue;
        }
        let is_lnk = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase() == "lnk")
            .unwrap_or(false);
        if !is_lnk || !seen_paths.insert(path.to_string_lossy().to_lowercase()) {
            continue;
        }
        let name = file_label(&path);
        let haystack = name.to_lowercase();
        if JUNK_MARKERS.iter().any(|b| haystack.contains(b)) {
            continue;
        }
        let Ok(lnk) = parselnk::Lnk::try_from(path.as_path()) else {
            continue;
        };
        let Some(target) = lnk_target(&lnk, &path) else {
            continue;
        };
        if Path::new(&target).is_dir() {
            continue;
        }
        if !seen_targets.insert(target.to_lowercase()) {
            continue;
        }
        let args = lnk
            .string_data
            .command_line_arguments
            .clone()
            .filter(|s| !s.trim().is_empty());
        out.push(Resolved {
            kind: "app".into(),
            name,
            target: path.to_string_lossy().into_owned(),
            args,
        });
    }
}

/// 固定项的运行态解析结果：exe 为空表示无法参与「正在运行」匹配
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PinResolved {
    pub name: String,
    pub exe: String,
}

/// 任务栏固定项添加时解析一次：lnk 解出内层目标（通常为 exe），
/// exe 文件返回自身；目录/文档等返回空 exe（仍可启动，只是不亮运行态）。
#[tauri::command]
pub fn resolve_pin_target(path: String) -> Option<PinResolved> {
    let p = Path::new(&path);
    if !p.exists() {
        return None;
    }
    let name = p
        .file_stem()
        .unwrap_or_else(|| p.file_name().unwrap_or_default())
        .to_string_lossy()
        .into_owned();
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "lnk" {
        let Ok(lnk) = parselnk::Lnk::try_from(p) else {
            return None;
        };
        let target = inner_target(
            lnk.link_info
                .local_base_path
                .clone()
                .filter(|s| !s.is_empty()),
            lnk.link_info.common_path_suffix.clone(),
            lnk.string_data.relative_path.clone(),
            p,
        )?;
        let exe = if Path::new(&target).is_dir() {
            String::new()
        } else {
            target
        };
        return Some(PinResolved { name, exe });
    }
    let exe = if ext == "exe" { path.clone() } else { String::new() };
    Some(PinResolved { name, exe })
}

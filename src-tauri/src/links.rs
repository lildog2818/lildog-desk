use serde::Serialize;
use std::path::Path;

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
    if let Some(base) = lnk
        .link_info
        .local_base_path
        .clone()
        .filter(|s| !s.is_empty())
    {
        let suffix = lnk
            .link_info
            .common_path_suffix
            .clone()
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
    if let Some(rel) = &lnk.string_data.relative_path {
        if let Some(parent) = path.parent() {
            let joined = parent.join(rel);
            if joined.exists() {
                return joined.to_string_lossy().into_owned().into();
            }
        }
    }
    None
}

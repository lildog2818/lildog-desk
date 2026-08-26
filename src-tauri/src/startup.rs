//! 开机启动项小组件后端：枚举 / 新增 / 删除登录自启动项。
//!
//! 数据来源与任务管理器「启动应用」的核心子集一致：
//! - 注册表 Run 键：HKCU、HKLM 的 `Software\Microsoft\Windows\CurrentVersion\Run`
//! - 启动文件夹：当前用户（shell:startup）与公共（shell:common startup）目录下的文件
//!
//! 新增统一写入 HKCU Run 键（无需管理员权限，同名值覆盖）；
//! 删除按来源执行：注册表删值，或启动文件夹内删文件。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    /// 来源：hkcu-run | hklm-run | user-startup | common-startup
    pub location: String,
    /// 删除凭据：注册表值名，或启动文件夹内的文件名（含扩展名）
    pub key: String,
    /// 显示名：文件名去扩展名；注册表值名原样
    pub name: String,
    /// 命令行（注册表）或文件完整路径（启动文件夹）
    pub command: String,
}

const RUN_SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// ---------------- 命令入口 ----------------

#[tauri::command]
pub async fn startup_list() -> Result<Vec<StartupItem>, String> {
    tauri::async_runtime::spawn_blocking(list_impl)
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

#[tauri::command]
pub async fn startup_add(name: String, command: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || add_impl(&name, &command))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

#[tauri::command]
pub async fn startup_remove(location: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_impl(&location, &key))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

fn list_impl() -> Result<Vec<StartupItem>, String> {
    #[cfg(target_os = "windows")]
    return imp::list_all();
    #[cfg(not(target_os = "windows"))]
    Err("开机启动项仅支持 Windows".into())
}

fn add_impl(name: &str, command: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return imp::add(name, command);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (name, command);
        Err("开机启动项仅支持 Windows".into())
    }
}

fn remove_impl(location: &str, key: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return imp::remove(location, key);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (location, key);
        Err("开机启动项仅支持 Windows".into())
    }
}

// ---------------- 校验（平台无关） ----------------

/// 注册表值名约束：不能包含反斜杠与控制字符
fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name.len() > 120 {
        return Err("名称过长（最多 120 字符）".into());
    }
    if name.contains('\\') || name.contains('/') || name.chars().any(|c| c.is_control()) {
        return Err("名称不能包含 \\/ 与控制字符".into());
    }
    Ok(name.to_string())
}

/// 命令行校验；裸路径含空格且真实存在时自动加引号
fn validate_command(raw: &str) -> Result<String, String> {
    let cmd = raw.trim();
    if cmd.is_empty() {
        return Err("命令/路径不能为空".into());
    }
    if cmd.len() > 2000 {
        return Err("命令过长（最多 2000 字符）".into());
    }
    let quoted = if cmd.contains(' ')
        && !cmd.starts_with('"')
        && std::path::Path::new(cmd).is_file()
    {
        format!("\"{cmd}\"")
    } else {
        cmd.to_string()
    };
    Ok(quoted)
}

// ---------------- Windows 实现 ----------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{validate_command, validate_name, StartupItem, RUN_SUBKEY};
    use std::path::{Path, PathBuf};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW, RegQueryInfoKeyW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_SZ,
    };
    use windows::Win32::UI::Shell::{
        SHGetKnownFolderPath, FOLDERID_CommonStartup, FOLDERID_Startup,
    };

    pub const LOC_HKCU_RUN: &str = "hkcu-run";
    pub const LOC_HKLM_RUN: &str = "hklm-run";
    pub const LOC_USER_STARTUP: &str = "user-startup";
    pub const LOC_COMMON_STARTUP: &str = "common-startup";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(err: WIN32_ERROR, what: &str) -> Result<(), String> {
        if err == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{what}失败（错误码 {}）", err.0))
        }
    }

    fn open_run_key(root: HKEY, writable: bool) -> Result<HKEY, String> {
        let sub = wide(RUN_SUBKEY);
        let mut out = HKEY::default();
        let access = if writable { KEY_SET_VALUE } else { KEY_READ };
        let err = unsafe { RegOpenKeyExW(root, PCWSTR(sub.as_ptr()), Some(0), access, &mut out) };
        check(err, "打开注册表 Run 键")?;
        Ok(out)
    }

    /// 把 REG_SZ / REG_EXPAND_SZ 的原始字节解码为字符串
    fn raw_to_command(ty: u32, data: &[u8]) -> Option<String> {
        if ty != REG_SZ.0 && ty != REG_EXPAND_SZ.0 {
            return None;
        }
        let units: Vec<u16> = data
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn list_run_values(root: HKEY, location: &'static str) -> Vec<StartupItem> {
        let mut out = Vec::new();
        let Ok(hk) = open_run_key(root, false) else {
            // HKLM 无读取权限等场景：跳过该来源而不是整体失败
            return out;
        };
        unsafe {
            let mut count = 0u32;
            let mut max_name_chars = 0u32;
            let mut max_data_bytes = 0u32;
            let err = RegQueryInfoKeyW(
                hk,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(&mut count),
                Some(&mut max_name_chars),
                Some(&mut max_data_bytes),
                None,
                None,
            );
            if err == ERROR_SUCCESS {
                let name_cap = max_name_chars.max(1) as usize + 1;
                let mut name_buf = vec![0u16; name_cap];
                let data_cap = max_data_bytes.max(2) as usize;
                let mut data_buf = vec![0u8; data_cap];
                for i in 0..count {
                    let mut name_len = name_cap as u32;
                    let mut ty = 0u32;
                    let mut data_len = data_cap as u32;
                    let err = RegEnumValueW(
                        hk,
                        i,
                        Some(PWSTR(name_buf.as_mut_ptr())),
                        &mut name_len,
                        None,
                        Some(&mut ty),
                        Some(data_buf.as_mut_ptr()),
                        Some(&mut data_len),
                    );
                    if err != ERROR_SUCCESS {
                        continue;
                    }
                    let key = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                    let usable = (data_len as usize).min(data_cap);
                    let command = raw_to_command(ty, &data_buf[..usable]).unwrap_or_default();
                    out.push(StartupItem {
                        location: location.to_string(),
                        key: key.clone(),
                        name: key,
                        command,
                    });
                }
            }
            let _ = RegCloseKey(hk);
        }
        out.sort_by_key(|it| it.name.to_lowercase());
        out
    }

    fn known_dir(guid: &windows::core::GUID) -> Option<PathBuf> {
        let pw = unsafe { SHGetKnownFolderPath(guid, windows::Win32::UI::Shell::KNOWN_FOLDER_FLAG(0), None) }
            .ok()?;
        let s = unsafe { pw.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(pw.as_ptr().cast())) };
        let trimmed = s.trim_end_matches('\0').to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    }

    fn user_startup_dir() -> Option<PathBuf> {
        known_dir(&FOLDERID_Startup)
    }

    fn common_startup_dir() -> Option<PathBuf> {
        known_dir(&FOLDERID_CommonStartup)
    }

    fn list_startup_folder(dir: Option<&Path>, location: &'static str) -> Vec<StartupItem> {
        let mut out = Vec::new();
        let Some(dir) = dir else {
            return out;
        };
        let Ok(rd) = std::fs::read_dir(dir) else {
            return out;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|f| f.to_str()) else {
                continue;
            };
            if file_name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|f| f.to_str())
                .unwrap_or(file_name);
            out.push(StartupItem {
                location: location.to_string(),
                key: file_name.to_string(),
                name: stem.to_string(),
                command: path.to_string_lossy().into_owned(),
            });
        }
        out.sort_by_key(|it| it.name.to_lowercase());
        out
    }

    pub fn list_all() -> Result<Vec<StartupItem>, String> {
        let user_dir = user_startup_dir();
        let common_dir = common_startup_dir();
        let mut out = Vec::new();
        // 顺序：用户文件夹 → HKCU Run → HKLM Run → 公共文件夹（近似任务管理器分组）
        out.extend(list_startup_folder(user_dir.as_deref(), LOC_USER_STARTUP));
        out.extend(list_run_values(HKEY_CURRENT_USER, LOC_HKCU_RUN));
        out.extend(list_run_values(HKEY_LOCAL_MACHINE, LOC_HKLM_RUN));
        out.extend(list_startup_folder(common_dir.as_deref(), LOC_COMMON_STARTUP));
        Ok(out)
    }

    fn utf16_le_bytes(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    pub fn add(name: &str, command: &str) -> Result<(), String> {
        let name = validate_name(name)?;
        let cmd = validate_command(command)?;
        let hk = open_run_key(HKEY_CURRENT_USER, true)?;
        let value_name = wide(&name);
        let data = utf16_le_bytes(&cmd);
        // 同名值已存在时 RegSetValueExW 直接覆盖，同样返回 ERROR_SUCCESS
        let result = unsafe {
            RegSetValueExW(
                hk,
                PCWSTR(value_name.as_ptr()),
                Some(0),
                REG_SZ,
                Some(data.as_slice()),
            )
        };
        unsafe {
            let _ = RegCloseKey(hk);
        }
        check(result, "写入注册表")
    }

    fn delete_run_value(root: HKEY, key: &str) -> Result<(), String> {
        let hk = open_run_key(root, true)?;
        let value_name = wide(key);
        let err = unsafe { RegDeleteValueW(hk, PCWSTR(value_name.as_ptr())) };
        unsafe {
            let _ = RegCloseKey(hk);
        }
        if err == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND
            || err == windows::Win32::Foundation::ERROR_PATH_NOT_FOUND
        {
            return Err("该启动项已不存在".into());
        }
        check(err, "删除注册表值")
    }

    /// 删除启动文件夹中的文件；key 必须是纯文件名，防目录穿越
    fn delete_startup_file(dir: Option<PathBuf>, key: &str) -> Result<(), String> {
        let Some(dir) = dir else {
            return Err("无法定位启动文件夹".into());
        };
        let target = dir.join(key);
        if target.parent() != Some(dir.as_path()) {
            return Err("非法的文件名".into());
        }
        if !target.is_file() {
            return Err("启动项文件不存在或已被移除".into());
        }
        std::fs::remove_file(&target).map_err(|e| format!("删除文件失败：{e}"))
    }

    pub fn remove(location: &str, key: &str) -> Result<(), String> {
        let key = key.trim();
        if key.is_empty()
            || key.len() > 255
            || key.contains('\\')
            || key.contains('/')
            || key.contains("..")
            || key.chars().any(|c| c.is_control())
        {
            return Err("非法的启动项标识".into());
        }
        match location {
            LOC_HKCU_RUN => delete_run_value(HKEY_CURRENT_USER, key),
            LOC_HKLM_RUN => delete_run_value(HKEY_LOCAL_MACHINE, key),
            LOC_USER_STARTUP => delete_startup_file(user_startup_dir(), key),
            LOC_COMMON_STARTUP => delete_startup_file(common_startup_dir(), key),
            _ => Err("未知的启动项来源".into()),
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn list_real_startup_items() {
        let items = imp::list_all().expect("list_all failed");
        println!("共 {} 个启动项：", items.len());
        for it in &items {
            println!(
                "  [{}/{}] {} => {}",
                it.location, it.key, it.name, it.command
            );
        }
        // 与 PowerShell 读注册表的结果交叉校验 HKCU Run 数量
        let hkcu_count = items
            .iter()
            .filter(|it| it.location == "hkcu-run")
            .count();
        println!("hkcu-run 数量: {hkcu_count}");
    }

    #[test]
    fn validate_rejects_bad_input() {
        assert!(super::validate_name("").is_err());
        assert!(super::validate_name("a\\b").is_err());
        assert!(super::validate_command("  ").is_err());
        assert!(super::validate_command("C:\\Program Files\\x.exe").is_ok());
    }
}

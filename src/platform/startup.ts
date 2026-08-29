import { invoke } from "@tauri-apps/api/core";

export interface StartupItem {
  /** 来源：hkcu-run | hklm-run | user-startup | common-startup */
  location: string;
  /** 删除凭据：注册表值名或启动文件夹内文件名 */
  key: string;
  /** 显示名 */
  name: string;
  /** 命令行 / 文件完整路径 */
  command: string;
}

export const listStartupItems = (): Promise<StartupItem[]> =>
  invoke<StartupItem[]>("startup_list");

/** 新增启动项：写入当前用户 Run 键（同名覆盖） */
export const addStartupItem = (name: string, command: string): Promise<void> =>
  invoke("startup_add", { name, command });

/** 取消（删除）一个启动项；HKLM 需要管理员权限，失败会抛错 */
export const removeStartupItem = (
  location: string,
  key: string,
): Promise<void> => invoke("startup_remove", { location, key });

/** 修改启动项指向：
 * 注册表项覆盖命令；启动文件夹 .lnk 重写链接目标；其余文件返回错误 */
export const startupEdit = (
  location: string,
  key: string,
  command: string,
): Promise<void> => invoke("startup_edit", { location, key, command });

/** 恢复一个被关闭的启动项：
 * 注册表项写回原值；启动文件夹项在该目录重建 .lnk 指向原命令 */
export const startupRestore = (
  location: string,
  key: string,
  name: string,
  command: string,
): Promise<void> =>
  invoke("startup_restore", { location, key, name, command });

/** 从命令行解析出可执行文件路径（含 %VAR% 展开；解析失败返回空串） */
export const startupTargetPath = (command: string): Promise<string> =>
  invoke<string>("startup_target_path", { command });

export const STARTUP_LOCATION_LABEL: Record<string, string> = {
  "hkcu-run": "当前用户 · 注册表",
  "hklm-run": "所有用户 · 注册表",
  "user-startup": "当前用户 · 启动文件夹",
  "common-startup": "所有用户 · 启动文件夹",
};

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

export const STARTUP_LOCATION_LABEL: Record<string, string> = {
  "hkcu-run": "当前用户 · 注册表",
  "hklm-run": "所有用户 · 注册表",
  "user-startup": "当前用户 · 启动文件夹",
  "common-startup": "所有用户 · 启动文件夹",
};

import { invoke } from "@tauri-apps/api/core";

export interface WinState {
  pinned: boolean;
  collapsed: boolean;
  bgOpacity: number;
  glass: number;
}

export interface TrayItem {
  id: string;
  title: string;
}

export const getWindowState = (): Promise<WinState> =>
  invoke<WinState>("get_window_state");

export const setPinned = (pin: boolean): Promise<void> =>
  invoke("set_pinned", { pin });

export const setCollapsed = (collapsed: boolean): Promise<void> =>
  invoke("set_collapsed", { collapsed });

export const setBgOpacity = (opacity: number): Promise<void> =>
  invoke("set_bg_opacity", { opacity });

export const setGlass = (v: number): Promise<void> => invoke("set_glass", { v });

export const getAutostart = (): Promise<boolean> => invoke("get_autostart");

export const setAutostart = (enable: boolean): Promise<void> =>
  invoke("set_autostart", { enable });

export const openWidgetWindow = (
  widgetId: string,
  title: string,
  width: number,
  height: number,
): Promise<void> =>
  invoke("open_widget_window", {
    widgetId,
    title,
    width,
    height,
  });

export const toggleWidgetWindow = (
  widgetId: string,
  title: string,
  width: number,
  height: number,
): Promise<void> =>
  invoke("toggle_widget_window", {
    widgetId,
    title,
    width,
    height,
  });

export const updateTrayWidgets = (items: TrayItem[]): Promise<void> =>
  invoke("update_tray_widgets", { items });

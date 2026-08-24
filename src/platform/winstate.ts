import { invoke } from "@tauri-apps/api/core";

export interface WinState {
  pinned: boolean;
  collapsed: boolean;
  bgOpacity: number;
  glass: number;
  sizeStep: number;
  fontColor?: string | null;
  bgColor?: string | null;
  /** 可读性增强级别：off=关闭 std=标准 max=强化 */
  textEffect?: string;
  /** 四类字号（px） */
  fontSizeUi?: number;
  fontSizeTitle?: number;
  fontSizeSmall?: number;
  fontSizeValue?: number;
}

export interface ThemeCfg {
  fontColor?: string | null;
  bgColor?: string | null;
}

/** 四类字号：界面正文 / 标题 / 辅助小字 / 数值 */
export interface FontSizes {
  ui: number;
  title: number;
  small: number;
  value: number;
}

export type TextEffectLevel = "off" | "std" | "max";

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

export const setSizeStep = (step: number): Promise<void> =>
  invoke("set_size_step", { step });

export const setTheme = (theme: ThemeCfg): Promise<void> =>
  invoke("set_theme", {
    fontColor: theme.fontColor ?? "",
    bgColor: theme.bgColor ?? "",
  });

export const setTextEffect = (level: TextEffectLevel): Promise<void> =>
  invoke("set_text_effect", { level });

export const setFontSizes = (sizes: FontSizes): Promise<void> =>
  invoke("set_font_sizes", {
    ui: sizes.ui,
    title: sizes.title,
    small: sizes.small,
    value: sizes.value,
  });

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

export const closeWidgetWindow = (widgetId: string): Promise<void> =>
  invoke("close_widget_window", { widgetId });

export const updateTrayWidgets = (items: TrayItem[]): Promise<void> =>
  invoke("update_tray_widgets", { items });

import { invoke } from "@tauri-apps/api/core";

export function widgetLoad<T>(widgetId: string, fallback: T): Promise<T> {
  return invoke<T | null>("load_widget_data", { widgetId }).then((v) =>
    v === null || v === undefined ? fallback : (v as T),
  );
}

export function widgetSave(widgetId: string, data: unknown): Promise<void> {
  return invoke("save_widget_data", { widgetId, data });
}

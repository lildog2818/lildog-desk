import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

export function widgetLoad<T>(widgetId: string, fallback: T): Promise<T> {
  return invoke<T | null>("load_widget_data", { widgetId }).then((v) =>
    v === null || v === undefined ? fallback : (v as T),
  );
}

export function widgetSave(widgetId: string, data: unknown): Promise<void> {
  return invoke("save_widget_data", { widgetId, data });
}

/**
 * 广播「某组件的数据已被改写」，让同组件的其它窗口（如果有）重新读取。
 * 写入方调用：本身不落盘，只负责通知。
 */
export function notifyWidgetData(widgetId: string): void {
  void emit("widget-data", { widgetId }).catch(() => {});
}

/**
 * 监听其它窗口对指定组件数据的改写（如番茄钟勾掉备忘录任务）。
 * 返回取消监听的函数。
 */
export function onWidgetDataChanged(
  widgetId: string,
  handler: () => void,
): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<{ widgetId?: string }>("widget-data", (ev) => {
    if (ev.payload?.widgetId === widgetId) handler();
  })
    .then((un) => {
      if (disposed) un();
      else unlisten = un;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

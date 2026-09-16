/**
 * 预览用 Tauri 核心桩：把 invoke 换成本地内存存储，
 * 让小组件能在普通浏览器里渲染出真实外观。
 */
type Store = Record<string, unknown>;

const g = globalThis as unknown as {
  __PREVIEW_STORE__?: Store;
};

function store(): Store {
  g.__PREVIEW_STORE__ ??= {};
  return g.__PREVIEW_STORE__;
}

export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const a = args ?? {};
  switch (cmd) {
    case "load_widget_data": {
      const v = store()[String(a.widgetId ?? "")];
      return Promise.resolve((v === undefined ? null : v) as T);
    }
    case "save_widget_data": {
      store()[String(a.widgetId ?? "")] = a.data;
      return Promise.resolve(undefined as T);
    }
    case "get_window_state":
      return Promise.resolve({
        pinned: false,
        collapsed: false,
        bgOpacity: 0.62,
        glass: 0,
        sizeStep: 32,
        textEffect: "std",
        fontSizeUi: 12.5,
        fontSizeTitle: 14,
        fontSizeSmall: 11,
        fontSizeValue: 13.5,
        dockBottom: false,
        fontColor: null,
        bgColor: null,
      } as T);
    default:
      return Promise.resolve(undefined as T);
  }
}

export interface PreviewWebview {
  listen<T>(
    event: string,
    handler: (ev: { payload: T }) => void,
  ): Promise<() => void>;
}

export function getCurrentWebview(): PreviewWebview {
  return {
    listen: () => Promise.resolve(() => {}),
  };
}

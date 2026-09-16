export function emit(event: string, payload?: unknown): Promise<void> {
  const g = globalThis as unknown as {
    __PREVIEW_EVENTS__?: Array<{ event: string; payload: unknown }>;
  };
  g.__PREVIEW_EVENTS__ ??= [];
  g.__PREVIEW_EVENTS__.push({ event, payload });
  return Promise.resolve();
}

export function listen<T>(
  _event: string,
  _handler: (ev: { payload: T }) => void,
): Promise<() => void> {
  return Promise.resolve(() => {});
}

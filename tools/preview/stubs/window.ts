export interface PreviewWindow {
  label: string;
  startDragging(): Promise<void>;
}

export function getCurrentWindow(): PreviewWindow {
  return {
    label: "w-pomodoro",
    startDragging: () => Promise.resolve(),
  };
}

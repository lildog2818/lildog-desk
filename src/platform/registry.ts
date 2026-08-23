export interface WidgetContext {
  windowLabel: string;
  embedded: boolean;
}

export type WidgetMountResult = void | (() => void);

export interface WidgetDef {
  id: string;
  name: string;
  icon: string;
  color: string;
  desc: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  mount(
    root: HTMLElement,
    ctx: WidgetContext,
  ): WidgetMountResult | Promise<WidgetMountResult>;
  unmount?(): void;
  /** 卡片摘要（dashboard 展示用） */
  summary?(): Promise<string> | string;
}

const defs = new Map<string, WidgetDef>();

export function registerWidget(def: WidgetDef): void {
  defs.set(def.id, def);
}

export function getWidget(id: string): WidgetDef | undefined {
  return defs.get(id);
}

export function allWidgets(): WidgetDef[] {
  return [...defs.values()];
}

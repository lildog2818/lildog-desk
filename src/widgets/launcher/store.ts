import { widgetLoad, widgetSave } from "../../platform/widget-data";

export interface Item {
  id: string;
  name: string;
  kind: "folder" | "app" | "url" | "file";
  target: string;
  args: string | null;
  icon: string | null;
  groupId: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export interface LauncherData {
  groups: Group[];
  items: Item[];
}

function defaultGroup(): Group {
  return { id: "g_default", name: "常用", color: "#ffb84d", collapsed: false };
}

export const state: { data: LauncherData } = {
  data: { groups: [defaultGroup()], items: [] },
};

export function uid(): string {
  return crypto.randomUUID();
}

export async function loadLauncherData(): Promise<void> {
  const d = await widgetLoad<LauncherData>("launcher", {
    groups: [defaultGroup()],
    items: [],
  });
  if (!Array.isArray(d.groups)) d.groups = [];
  if (!Array.isArray(d.items)) d.items = [];
  if (d.groups.length === 0) d.groups.push(defaultGroup());
  state.data = d;
}

let saveTimer: number | undefined;

export function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("launcher", state.data);
  }, 250);
}

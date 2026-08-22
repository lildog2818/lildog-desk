import { invoke } from "@tauri-apps/api/core";

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

interface Settings {
  pinned: boolean;
  collapsed: boolean;
  bgOpacity?: number;
}

export const state = {
  groups: [] as Group[],
  items: [] as Item[],
  settings: { pinned: false, collapsed: false } as Settings,
};

export function uid(): string {
  return crypto.randomUUID();
}

export async function loadAll(): Promise<void> {
  const snap = await invoke<{
    store: { groups: Group[]; items: Item[] };
    settings: Settings;
  }>("load_all");
  state.groups = snap.store.groups ?? [];
  state.items = snap.store.items ?? [];
  state.settings = snap.settings;
}

let saveTimer: number | undefined;

export function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void invoke("persist_store", {
      store: { groups: state.groups, items: state.items },
    });
  }, 250);
}

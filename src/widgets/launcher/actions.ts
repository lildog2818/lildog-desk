import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildMenu,
  button,
  closeOverlays,
  confirmDanger,
  field,
  modal,
  promptText,
  textInput,
  toast,
} from "../../platform/shell";
import {
  scheduleSave,
  state,
  uid,
  type Group,
  type Item,
} from "./store";

export const PALETTE = [
  "#ffb84d",
  "#ff7eb6",
  "#6ee7b7",
  "#7dd3fc",
  "#c4b5fd",
  "#fca5a5",
  "#fde047",
];

const iconPending = new Set<string>();
const iconFailed = new Set<string>();

let renderHook: () => void = () => {};

export function bindRender(fn: () => void): void {
  renderHook = fn;
}

export function requestRender(): void {
  renderHook();
}

export async function importPaths(
  paths: string[],
  groupId: string,
): Promise<void> {
  const resolved = await invoke<
    Array<{
      kind: Item["kind"];
      name: string;
      target: string;
      args: string | null;
    }>
  >("resolve_paths", { paths });
  const added: string[] = [];
  for (const r of resolved) {
    if (
      state.data.items.some(
        (i) => i.target.toLowerCase() === r.target.toLowerCase(),
      )
    )
      continue;
    state.data.items.push({
      id: uid(),
      name: r.name,
      kind: r.kind,
      target: r.target,
      args: r.args,
      icon: null,
      groupId,
    });
    added.push(r.target);
  }
  if (added.length > 0) {
    scheduleSave();
    requestRender();
    toast(added.length > 1 ? `已导入 ${added.length} 项` : "已导入");
    for (const t of added) void fetchIcon(t);
  } else {
    toast("没有新增项");
  }
}

export async function fetchIcon(target: string): Promise<void> {
  const key = target.toLowerCase();
  if (iconPending.has(key) || iconFailed.has(key)) return;
  iconPending.add(key);
  try {
    const p = await invoke<string>("get_icon", { path: target });
    const item = state.data.items.find((i) => i.target.toLowerCase() === key);
    if (item && p) {
      item.icon = p;
      scheduleSave();
      requestRender();
    } else if (!p) {
      iconFailed.add(key);
    }
  } catch {
    iconFailed.add(key);
  } finally {
    iconPending.delete(key);
  }
}

export async function addFolder(groupId: string): Promise<void> {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return;
  await importPaths([picked], groupId);
}

export async function addApp(groupId: string): Promise<void> {
  const picked = await open({
    multiple: false,
    filters: [
      {
        name: "应用与快捷方式",
        extensions: ["lnk", "url", "exe", "bat", "cmd"],
      },
    ],
  });
  if (typeof picked !== "string") return;
  await importPaths([picked], groupId);
}

interface AppEntry {
  kind: Item["kind"];
  name: string;
  target: string;
  args: string | null;
}

let appListCache: AppEntry[] | null = null;

function activeGroupId(): string {
  return state.data.groups[0]?.id ?? "";
}

/**
 * 通用「从开始菜单选应用」选择器：isAdded 决定已添加置灰态，
 * onPick 在用户选中某个应用时回调；browse 提供时才显示"浏览文件…"按钮。
 * 任务栏等外部组件复用此入口，不必触碰 launcher 的 store。
 */
export function showAppPicker(opts: {
  isAdded: (target: string) => boolean;
  onPick: (a: AppEntry) => void;
  browse?: () => void;
}): void {
  const { isAdded, onPick, browse } = opts;
  closeOverlays();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog picker";
  const h = document.createElement("h3");
  h.textContent = "从应用列表添加";
  const searchInput = textInput("", "搜索应用…");
  searchInput.className = "picker-search";
  const list = document.createElement("div");
  list.className = "picker-list";
  const status = document.createElement("div");
  status.className = "picker-status";
  status.textContent = "正在读取应用列表…";
  const bar = document.createElement("div");
  bar.className = "dialog-btns";
  if (browse) {
    bar.append(
      button("浏览文件…", "", () => {
        closeOverlays();
        browse();
      }),
    );
  }
  bar.append(button("关闭", "", () => closeOverlays()));

  box.append(h, searchInput, list, status, bar);
  overlay.appendChild(box);
  overlay.onpointerdown = (ev) => {
    if (ev.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
  searchInput.focus();

  const alive = (): boolean => overlay.isConnected;
  const iconCache = new Map<string, string>();
  let activeIcons = 0;
  const iconQueue: Array<() => void> = [];
  const pumpIcons = (): void => {
    while (activeIcons < 4 && iconQueue.length > 0) {
      activeIcons++;
      iconQueue.shift()!();
    }
  };
  const setRowImg = (row: HTMLDivElement, p: string): void => {
    const ic = row.querySelector(".pick-icon");
    if (!ic || ic.querySelector("img")) return;
    ic.innerHTML = "";
    const img = document.createElement("img");
    img.src = convertFileSrc(p);
    img.draggable = false;
    ic.appendChild(img);
  };
  const ensureIcon = (a: AppEntry, row: HTMLDivElement): void => {
    const key = a.target.toLowerCase();
    const cached = iconCache.get(key);
    if (cached !== undefined) {
      if (cached) setRowImg(row, cached);
      return;
    }
    iconCache.set(key, "");
    iconQueue.push(() => {
      void invoke<string>("get_icon", { path: a.target })
        .then((p) => {
          iconCache.set(key, p ?? "");
          if (alive() && p) setRowImg(row, p);
        })
        .catch(() => {})
        .finally(() => {
          activeIcons--;
          pumpIcons();
        });
    });
    pumpIcons();
  };

  let apps: AppEntry[] = appListCache ?? [];
  const renderList = (): void => {
    const q = searchInput.value.trim().toLowerCase();
    const shown = q
      ? apps.filter((a) => a.name.toLowerCase().includes(q))
      : apps;
    status.textContent =
      shown.length === 0
        ? apps.length === 0
          ? "未在开始菜单中找到应用"
          : "没有匹配的应用"
        : `${shown.length} 个应用`;
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const a of shown.slice(0, 300)) {
      const row = document.createElement("div");
      row.className = "pick-row" + (isAdded(a.target) ? " added" : "");
      row.title = a.name;
      const ic = document.createElement("span");
      ic.className = "pick-icon";
      const fb = document.createElement("span");
      fb.innerHTML = FALLBACK[a.kind] ?? FALLBACK.file;
      ic.appendChild(fb);
      const label = document.createElement("span");
      label.className = "pick-name";
      label.textContent = a.name;
      row.append(ic, label);
      row.onclick = () => {
        if (isAdded(a.target)) {
          toast("该项已存在");
          return;
        }
        onPick(a);
      };
      ensureIcon(a, row);
      frag.appendChild(row);
    }
    list.appendChild(frag);
  };

  searchInput.oninput = () => renderList();
  searchInput.onkeydown = (ev) => {
    if (ev.key !== "Enter") return;
    list.querySelector<HTMLDivElement>(".pick-row:not(.added)")?.click();
  };

  if (apps.length === 0) {
    void invoke<AppEntry[]>("list_apps")
      .then((r) => {
        r.sort((x, y) => x.name.localeCompare(y.name, "zh-Hans-CN"));
        appListCache = r;
        apps = r;
        if (alive()) renderList();
      })
      .catch((e) => {
        if (alive()) status.textContent = `读取失败：${String(e)}`;
      });
  } else {
    renderList();
  }
}

/** launcher 自己的选择器入口：写入当前激活分组 */
export function openAppPicker(): void {
  showAppPicker({
    isAdded: (target) =>
      state.data.items.some(
        (i) => i.target.toLowerCase() === target.toLowerCase(),
      ),
    onPick: (a) => void importPaths([a.target], activeGroupId()),
    browse: () => void addApp(activeGroupId()),
  });
}

export const FALLBACK: Record<string, string> = {
  folder:
    '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2.2 2.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>',
  app: '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 4v10h14V8H5zm2-2.2a1.1 1.1 0 1 1 0 .01zM9 5.9a.9.9 0 1 0 0-.01z" fill-rule="evenodd"/></svg>',
  url: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3.4a15 15 0 0 0-1.2-5.2A8 8 0 0 1 19.9 11zM12 4c.9 1.2 1.9 3.5 2.3 7H9.7c.4-3.5 1.4-5.8 2.3-7zM4.1 13h3.4c.2 2 .6 3.8 1.2 5.2A8 8 0 0 1 4.1 13zm3.4-2H4.1a8 8 0 0 1 4.6-5.2A15 15 0 0 0 7.5 11zM12 20c-.9-1.2-1.9-3.5-2.3-7h4.6c-.4 3.5-1.4 5.8-2.3 7zm3.3-1.8c.6-1.4 1-3.2 1.2-5.2h3.4a8 8 0 0 1-4.6 5.2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5z"/></svg>',
};

export function addGroup(): void {
  promptText("新建分组", `分组 ${state.data.groups.length + 1}`, (name) => {
    state.data.groups.push({
      id: uid(),
      name,
      color: PALETTE[state.data.groups.length % PALETTE.length],
      collapsed: false,
    });
    scheduleSave();
    requestRender();
  });
}

function openItem(item: Item): void {
  void invoke("open_target", { target: item.target }).catch((e) =>
    toast(String(e)),
  );
}

function revealItem(item: Item): void {
  void invoke("reveal_target", { target: item.target }).catch((e) =>
    toast(String(e)),
  );
}

function editDialog(item: Item): void {
  const nameInput = textInput(item.name);
  const argsInput = textInput(item.args ?? "");
  const groupSel = document.createElement("select");
  for (const g of state.data.groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    opt.selected = g.id === item.groupId;
    groupSel.appendChild(opt);
  }
  const pathNote = document.createElement("div");
  pathNote.className = "path-note";
  pathNote.textContent = item.target;

  const fields = [
    field("名称", nameInput),
    field("目标路径", pathNote),
    field("分组", groupSel),
  ];
  if (item.kind === "app") fields.push(field("启动参数（可选）", argsInput));

  modal("编辑快捷方式", fields, [
    button("删除", "danger", () => {
      closeOverlays();
      confirmDanger(`确定删除「${item.name}」吗？`, () => {
        state.data.items = state.data.items.filter((i) => i.id !== item.id);
        scheduleSave();
        requestRender();
      });
    }),
    button("取消", "", () => closeOverlays()),
    button("保存", "primary", () => {
      item.name = nameInput.value.trim() || item.name;
      item.groupId = groupSel.value;
      if (item.kind === "app") {
        const a = argsInput.value.trim();
        item.args = a || null;
      }
      scheduleSave();
      requestRender();
      closeOverlays();
    }),
  ]);
}

export function itemMenu(ev: MouseEvent, item: Item): void {
  buildMenu(ev.clientX, ev.clientY, [
    { label: "打开", action: () => openItem(item) },
    { label: "打开所在位置", action: () => revealItem(item) },
    { label: "编辑…", action: () => editDialog(item) },
    {
      label: "移动到分组",
      sub: state.data.groups
        .filter((g) => g.id !== item.groupId)
        .map((g) => ({
          label: g.name,
          action: () => {
            item.groupId = g.id;
            scheduleSave();
            requestRender();
          },
        })),
    },
    {
      label: "删除",
      danger: true,
      action: () =>
        confirmDanger(`确定删除「${item.name}」吗？`, () => {
          state.data.items = state.data.items.filter((i) => i.id !== item.id);
          scheduleSave();
          requestRender();
        }),
    },
  ]);
}

export function groupMenu(ev: MouseEvent, group: Group): void {
  buildMenu(ev.clientX, ev.clientY, [
    {
      label: "重命名…",
      action: () =>
        promptText("重命名分组", group.name, (name) => {
          group.name = name;
          scheduleSave();
          requestRender();
        }),
    },
    {
      label: "换个颜色",
      action: () => {
        const idx = PALETTE.indexOf(group.color);
        group.color = PALETTE[(idx + 1) % PALETTE.length];
        scheduleSave();
        requestRender();
      },
    },
    {
      label: "删除分组",
      danger: true,
      action: () => {
        if (state.data.groups.length <= 1) {
          toast("至少保留一个分组");
          return;
        }
        confirmDanger(
          `删除「${group.name}」，其中条目将移入第一个分组。`,
          () => {
            const fallback = state.data.groups.find(
              (g) => g.id !== group.id,
            )!;
            for (const it of state.data.items)
              if (it.groupId === group.id) it.groupId = fallback.id;
            state.data.groups = state.data.groups.filter(
              (g) => g.id !== group.id,
            );
            scheduleSave();
            requestRender();
          },
        );
      },
    },
  ]);
}

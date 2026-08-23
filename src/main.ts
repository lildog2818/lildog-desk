import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { loadAll, scheduleSave, state, uid, type Group, type Item } from "./store";

function applyPanelAlpha(v: number): void {
  document.documentElement.style.setProperty("--panel-a", String(v));
}

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const board = $("#board");
const header = $("#header");
const search = $<HTMLInputElement>("#search");
const btnAdd = $("#btn-add");
const btnGear = $("#btn-gear");
const btnPin = $("#btn-pin");
const btnCollapse = $("#btn-collapse");
const pill = $("#pill");
const pillCount = $("#pill-count");
const dropveil = $("#dropveil");
const dropTargetName = $("#drop-target-name");

const PALETTE = [
  "#ffb84d",
  "#ff7eb6",
  "#6ee7b7",
  "#7dd3fc",
  "#c4b5fd",
  "#fca5a5",
  "#fde047",
];

const FALLBACK: Record<string, string> = {
  folder:
    '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2.2 2.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>',
  app: '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 4v10h14V8H5zm2-2.2a1.1 1.1 0 1 1 0 .01zM9 5.9a.9.9 0 1 0 0-.01z" fill-rule="evenodd"/></svg>',
  url: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3.4a15 15 0 0 0-1.2-5.2A8 8 0 0 1 19.9 11zM12 4c.9 1.2 1.9 3.5 2.3 7H9.7c.4-3.5 1.4-5.8 2.3-7zM4.1 13h3.4c.2 2 .6 3.8 1.2 5.2A8 8 0 0 1 4.1 13zm3.4-2H4.1a8 8 0 0 1 4.6-5.2A15 15 0 0 0 7.5 11zM12 20c-.9-1.2-1.9-3.5-2.3-7h4.6c-.4 3.5-1.4 5.8-2.3 7zm3.3-1.8c.6-1.4 1-3.2 1.2-5.2h3.4a8 8 0 0 1-4.6 5.2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5z"/></svg>',
};

let didDrag = false;
const iconPending = new Set<string>();
const iconFailed = new Set<string>();

function toast(msg: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  const prev = Number((el as HTMLElement & { _t?: number })._t ?? 0);
  window.clearTimeout(prev);
  el.textContent = msg;
  el.classList.add("show");
  const t = window.setTimeout(() => el.classList.remove("show"), 1600);
  (el as HTMLElement & { _t?: number })._t = t;
}

function closeMenus(): void {
  document.querySelectorAll(".ctx").forEach((m) => m.remove());
}

function closeOverlays(): void {
  closeMenus();
  document.querySelectorAll(".overlay").forEach((o) => o.remove());
}

function buildMenu(
  x: number,
  y: number,
  entries: Array<{
    label?: string;
    danger?: boolean;
    action?: () => void;
    sub?: Array<{ label: string; action: () => void }>;
  }>,
): void {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "ctx";
  for (const e of entries) {
    if (e.sub) {
      const row = document.createElement("div");
      row.className = "ctx-item ctx-has";
      row.textContent = e.label ?? "";
      const arrow = document.createElement("span");
      arrow.textContent = "›";
      arrow.style.opacity = "0.5";
      row.appendChild(arrow);
      const sub = document.createElement("div");
      sub.className = "ctx-sub";
      for (const s of e.sub) {
        const sr = document.createElement("div");
        sr.className = "ctx-item";
        sr.textContent = s.label;
        sr.onclick = () => {
          closeMenus();
          s.action();
        };
        sub.appendChild(sr);
      }
      row.appendChild(sub);
      menu.appendChild(row);
      continue;
    }
    const row = document.createElement("div");
    row.className = e.danger ? "ctx-item danger" : "ctx-item";
    row.textContent = e.label ?? "";
    row.onclick = () => {
      closeMenus();
      e.action?.();
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function modal(title: string, fields: HTMLDivElement[], buttons: HTMLButtonElement[]): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);
  for (const f of fields) box.appendChild(f);
  const bar = document.createElement("div");
  bar.className = "dialog-btns";
  for (const b of buttons) bar.appendChild(b);
  box.appendChild(bar);
  overlay.appendChild(box);
  overlay.onpointerdown = (ev) => {
    if (ev.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
  const input = box.querySelector<HTMLInputElement>("input");
  if (input) {
    input.focus();
    input.select();
  }
}

function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

function button(label: string, cls: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.onclick = () => onClick?.();
  return b;
}

function promptText(
  title: string,
  initial: string,
  commit: (value: string) => void,
): void {
  const input = textInput(initial);
  const ok = () => {
    const v = input.value.trim();
    if (v) commit(v);
    closeOverlays();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") ok();
  };
  modal(title, [field("名称", input)], [
    button("取消", "", () => closeOverlays()),
    button("确定", "primary", ok),
  ]);
}

function confirmDanger(message: string, commit: () => void): void {
  const note = document.createElement("div");
  note.className = "path-note";
  note.textContent = message;
  modal("确认操作", [note], [
    button("取消", "", () => closeOverlays()),
    button("删除", "danger", () => {
      closeOverlays();
      commit();
    }),
  ]);
}

function editDialog(item: Item): void {
  const nameInput = textInput(item.name);
  const argsInput = textInput(item.args ?? "");
  const groupSel = document.createElement("select");
  for (const g of state.groups) {
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
        state.items = state.items.filter((i) => i.id !== item.id);
        scheduleSave();
        render();
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
      render();
      closeOverlays();
    }),
  ]);
}

async function importPaths(paths: string[], groupId: string): Promise<void> {
  const resolved = await invoke<
    Array<{ kind: Item["kind"]; name: string; target: string; args: string | null }>
  >("resolve_paths", { paths });
  const added: string[] = [];
  for (const r of resolved) {
    if (state.items.some((i) => i.target.toLowerCase() === r.target.toLowerCase()))
      continue;
    state.items.push({
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
    render();
    toast(added.length > 1 ? `已导入 ${added.length} 项` : "已导入");
    for (const t of added) void fetchIcon(t);
  } else {
    toast("没有新增项");
  }
}

async function fetchIcon(target: string): Promise<void> {
  const key = target.toLowerCase();
  if (iconPending.has(key) || iconFailed.has(key)) return;
  iconPending.add(key);
  try {
    const p = await invoke<string>("get_icon", { path: target });
    const item = state.items.find(
      (i) => i.target.toLowerCase() === key,
    );
    if (item && p) {
      item.icon = p;
      scheduleSave();
      render();
    } else if (!p) {
      iconFailed.add(key);
    }
  } catch {
    iconFailed.add(key);
  } finally {
    iconPending.delete(key);
  }
}

async function addFolder(): Promise<void> {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return;
  await importPaths([picked], activeGroupId());
}

async function addApp(): Promise<void> {
  const picked = await open({
    multiple: false,
    filters: [
      { name: "应用与快捷方式", extensions: ["lnk", "url", "exe", "bat", "cmd"] },
    ],
  });
  if (typeof picked !== "string") return;
  await importPaths([picked], activeGroupId());
}

function addGroup(): void {
  promptText("新建分组", `分组 ${state.groups.length + 1}`, (name) => {
    state.groups.push({
      id: uid(),
      name,
      color: PALETTE[state.groups.length % PALETTE.length],
      collapsed: false,
    });
    scheduleSave();
    render();
  });
}

function activeGroupId(): string {
  return state.groups[0]?.id ?? "";
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

function itemMenu(ev: MouseEvent, item: Item): void {
  buildMenu(ev.clientX, ev.clientY, [
    { label: "打开", action: () => openItem(item) },
    { label: "打开所在位置", action: () => revealItem(item) },
    { label: "编辑…", action: () => editDialog(item) },
    {
      label: "移动到分组",
      sub: state.groups
        .filter((g) => g.id !== item.groupId)
        .map((g) => ({
          label: g.name,
          action: () => {
            item.groupId = g.id;
            scheduleSave();
            render();
          },
        })),
    },
    {
      label: "删除",
      danger: true,
      action: () =>
        confirmDanger(`确定删除「${item.name}」吗？`, () => {
          state.items = state.items.filter((i) => i.id !== item.id);
          scheduleSave();
          render();
        }),
    },
  ]);
}

function groupMenu(ev: MouseEvent, group: Group): void {
  buildMenu(ev.clientX, ev.clientY, [
    {
      label: "重命名…",
      action: () =>
        promptText("重命名分组", group.name, (name) => {
          group.name = name;
          scheduleSave();
          render();
        }),
    },
    {
      label: "换个颜色",
      action: () => {
        const idx = PALETTE.indexOf(group.color);
        group.color = PALETTE[(idx + 1) % PALETTE.length];
        scheduleSave();
        render();
      },
    },
    {
      label: "删除分组",
      danger: true,
      action: () => {
        if (state.groups.length <= 1) {
          toast("至少保留一个分组");
          return;
        }
        confirmDanger(`删除「${group.name}」，其中条目将移入第一个分组。`, () => {
          const fallback = state.groups.find((g) => g.id !== group.id)!;
          for (const it of state.items)
            if (it.groupId === group.id) it.groupId = fallback.id;
          state.groups = state.groups.filter((g) => g.id !== group.id);
          scheduleSave();
          render();
        });
      },
    },
  ]);
}

function tileEl(item: Item): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = item.id;

  if (item.icon) {
    const img = document.createElement("img");
    img.src = convertFileSrc(item.icon);
    img.draggable = false;
    tile.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "fallback";
    fb.innerHTML = FALLBACK[item.kind] ?? FALLBACK.file;
    tile.appendChild(fb);
    void fetchIcon(item.target);
  }

  const label = document.createElement("div");
  label.className = "tile-label";
  label.textContent = item.name;
  label.title = item.name;
  tile.appendChild(label);

  tile.onclick = () => {
    if (!didDrag) openItem(item);
  };
  tile.oncontextmenu = (ev) => {
    ev.preventDefault();
    itemMenu(ev, item);
  };

  attachPointerDrag(tile, item);
  return tile;
}

function attachPointerDrag(tile: HTMLDivElement, item: Item): void {
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let ghost: HTMLDivElement | null = null;
  let offX = 0;
  let offY = 0;

  const removeGhost = (): void => {
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("drag-active");
  };

  tile.onpointerdown = (down) => {
    if (down.button !== 0) return;
    startX = down.clientX;
    startY = down.clientY;
    dragging = false;

    const move = (mv: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(mv.clientX - startX, mv.clientY - startY) > 6
      ) {
        dragging = true;
        didDrag = true;
        tile.classList.add("dragging");
        tile.style.pointerEvents = "none";

        const rect = tile.getBoundingClientRect();
        offX = mv.clientX - rect.left;
        offY = mv.clientY - rect.top;
        ghost = tile.cloneNode(true) as HTMLDivElement;
        ghost.className = "tile drag-ghost";
        ghost.style.width = `${rect.width}px`;
        ghost.style.left = `${mv.clientX - offX}px`;
        ghost.style.top = `${mv.clientY - offY}px`;
        document.body.appendChild(ghost);
        document.body.classList.add("drag-active");
      }
      if (!dragging) return;
      if (ghost) {
        ghost.style.left = `${mv.clientX - offX}px`;
        ghost.style.top = `${mv.clientY - offY}px`;
      }
      clearDropMarks();
      const el = document.elementFromPoint(mv.clientX, mv.clientY);
      const hit = el?.closest(".tile") as HTMLElement | null;
      const grid = el?.closest(".grid") as HTMLElement | null;
      if (hit && hit.dataset.id !== item.id) hit.classList.add("drop-target");
      else if (grid) grid.parentElement?.classList.add("group-drop");
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      removeGhost();
    };

    const up = (upEv: PointerEvent) => {
      cleanup();
      clearDropMarks();
      tile.classList.remove("dragging");
      tile.style.pointerEvents = "";
      if (!dragging) return;
      window.setTimeout(() => (didDrag = false), 50);

      const el = document.elementFromPoint(upEv.clientX, upEv.clientY);
      const hit = el?.closest(".tile") as HTMLElement | null;
      const groupEl = el?.closest(".group") as HTMLElement | null;
      const targetGroup = groupEl?.getAttribute("data-gid");

      if (hit && hit.dataset.id && hit.dataset.id !== item.id) {
        const other = state.items.find((i) => i.id === hit.dataset.id)!;
        const fromIdx = state.items.indexOf(item);
        const toIdx = state.items.indexOf(other);
        state.items.splice(fromIdx, 1);
        const shifted = fromIdx < toIdx ? toIdx - 1 : toIdx;
        state.items.splice(shifted, 0, item);
        item.groupId = other.groupId;
      } else if (targetGroup) {
        item.groupId = targetGroup;
      } else {
        didDrag = false;
        return;
      }
      scheduleSave();
      render();
    };

    const cancel = () => {
      cleanup();
      clearDropMarks();
      tile.classList.remove("dragging");
      tile.style.pointerEvents = "";
      didDrag = false;
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
}

function clearDropMarks(): void {
  document
    .querySelectorAll(".drop-target")
    .forEach((el) => el.classList.remove("drop-target"));
  document
    .querySelectorAll(".group-drop")
    .forEach((el) => el.classList.remove("group-drop"));
}

function render(): void {
  closeMenus();
  board.innerHTML = "";
  const q = search.value.trim().toLowerCase();

  let shown = 0;
  for (const group of state.groups) {
    const items = state.items.filter(
      (i) =>
        i.groupId === group.id &&
        (!q || i.name.toLowerCase().includes(q)),
    );
    if (q && items.length === 0) continue;
    shown += items.length;

    const section = document.createElement("section");
    section.className = "group" + (group.collapsed ? " collapsed" : "");
    section.setAttribute("data-gid", group.id);

    const head = document.createElement("div");
    head.className = "group-head";
    const dot = document.createElement("span");
    dot.className = "group-dot";
    dot.style.background = group.color;
    dot.style.color = group.color;
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(items.length);
    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.textContent = "▾";
    head.append(dot, name, count, chevron);

    head.onclick = () => {
      group.collapsed = !group.collapsed;
      scheduleSave();
      render();
    };
    head.oncontextmenu = (ev) => {
      ev.preventDefault();
      groupMenu(ev, group);
    };
    section.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "grid";
    for (const item of items) grid.appendChild(tileEl(item));
    section.appendChild(grid);
    board.appendChild(section);
  }

  if (shown === 0 && q) {
    board.appendChild(emptyHint("没有匹配的结果"));
  } else if (state.items.length === 0) {
    board.appendChild(emptyHint("把桌面图标或文件夹拖进来"));
  }

  pillCount.textContent = `${state.items.length} 项`;
  btnPin.classList.toggle("active", state.settings.pinned);
}

function emptyHint(text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "empty-hint";
  const dog = document.createElement("span");
  dog.className = "dog";
  dog.textContent = "🐶";
  div.appendChild(dog);
  div.appendChild(document.createTextNode(text));
  return div;
}

search.oninput = () => render();

btnAdd.onclick = (ev) => {
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  buildMenu(rect.left, rect.bottom + 6, [
    { label: "添加文件夹…", action: () => void addFolder() },
    { label: "添加应用或快捷方式…", action: () => void addApp() },
    { label: "新建分组…", action: addGroup },
  ]);
};

btnPin.onclick = () => {
  const next = !state.settings.pinned;
  state.settings.pinned = next;
  btnPin.classList.toggle("active", next);
  void invoke("set_pinned", { pin: next });
};

let opacitySaveTimer = 0;

btnGear.onclick = (ev) => {
  const wasOpen = document.querySelector(".opacity-pop");
  closeMenus();
  if (wasOpen) return;
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();

  const pop = document.createElement("div");
  pop.className = "ctx opacity-pop";
  pop.style.left = `${rect.right - 200}px`;
  pop.style.top = `${rect.bottom + 6}px`;

  const head = document.createElement("div");
  head.className = "opacity-head";
  const title = document.createElement("span");
  title.textContent = "面板透明度";
  const val = document.createElement("span");
  val.className = "opacity-val";
  head.append(title, val);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "opacity-slider";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.01";

  let current = state.settings.bgOpacity ?? 0.55;
  current = Math.min(1, Math.max(0, current));
  slider.value = String(current);
  val.textContent = `${Math.round(current * 100)}%`;

  slider.oninput = () => {
    current = parseFloat(slider.value);
    applyPanelAlpha(current);
    val.textContent = `${Math.round(current * 100)}%`;
    window.clearTimeout(opacitySaveTimer);
    opacitySaveTimer = window.setTimeout(() => {
      state.settings.bgOpacity = current;
      void invoke("set_bg_opacity", { opacity: current });
    }, 250);
  };

  pop.append(head, slider);

  const autoRow = document.createElement("div");
  autoRow.className = "auto-row";
  const autoLabel = document.createElement("span");
  autoLabel.textContent = "开机自启";
  const autoToggle = document.createElement("button");
  autoToggle.className = "auto-toggle";
  autoToggle.setAttribute("aria-pressed", "false");
  const applyAutoState = (on: boolean): void => {
    autoToggle.classList.toggle("on", on);
    autoToggle.setAttribute("aria-pressed", String(on));
  };
  autoRow.append(autoLabel, autoToggle);
  pop.appendChild(autoRow);

  void invoke<boolean>("get_autostart")
    .then((v) => applyAutoState(v))
    .catch(() => applyAutoState(false));
  autoToggle.onclick = () => {
    const next = !autoToggle.classList.contains("on");
    void invoke("set_autostart", { enable: next })
      .then(() => applyAutoState(next))
      .catch((e) => toast(String(e)));
  };

  document.body.appendChild(pop);
};

btnCollapse.onclick = () => {
  document.body.classList.add("collapsed");
  void invoke("set_collapsed", { collapsed: true });
};

let pillPress: { x: number; y: number } | null = null;

pill.onpointerdown = (ev) => {
  if (ev.button !== 0) return;
  pillPress = { x: ev.clientX, y: ev.clientY };
  const move = (mv: PointerEvent) => {
    if (
      pillPress &&
      Math.hypot(mv.clientX - pillPress.x, mv.clientY - pillPress.y) > 6
    ) {
      pillPress = null;
      window.removeEventListener("pointermove", move);
      void getCurrentWindow().startDragging();
    }
  };
  const finish = () => {
    window.removeEventListener("pointermove", move);
    if (!pillPress) return;
    pillPress = null;
    document.body.classList.remove("collapsed");
    void invoke("set_collapsed", { collapsed: false });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
};

header.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("button,input,#search-wrap")) return;
  void getCurrentWindow().startDragging();
});

document.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement;
  if (!t.closest(".ctx")) closeMenus();
  if (!t.closest(".overlay,.ctx")) closeOverlays();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closeOverlays();
    search.blur();
  }
});

type DropPayload =
  | { type: "enter" | "over"; paths: string[]; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

function clientPos(p: { x: number; y: number }): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: p.x / dpr, y: p.y / dpr };
}

function groupAt(x: number, y: number): Group | undefined {
  const el = document.elementFromPoint(x, y);
  const gid = el?.closest(".group")?.getAttribute("data-gid");
  return state.groups.find((g) => g.id === gid) ?? state.groups[0];
}

void getCurrentWebview().onDragDropEvent((ev) => {
  const payload = ev.payload as DropPayload;
  if (payload.type === "enter" || payload.type === "over") {
    const pos = clientPos(payload.position);
    const g = groupAt(pos.x, pos.y);
    dropTargetName.textContent = g?.name ?? "";
    dropveil.classList.add("active");
  } else if (payload.type === "drop") {
    const pos = clientPos(payload.position);
    const g = groupAt(pos.x, pos.y);
    dropveil.classList.remove("active");
    if (g && payload.paths.length) void importPaths([...payload.paths], g.id);
  } else {
    dropveil.classList.remove("active");
  }
});

async function init(): Promise<void> {
  await loadAll();
  applyPanelAlpha(state.settings.bgOpacity ?? 0.55);
  if (state.settings.pinned) btnPin.classList.add("active");
  if (state.settings.collapsed) document.body.classList.add("collapsed");
  render();
}

void getCurrentWebview().listen<number>("bg-opacity", (ev) => {
  applyPanelAlpha(ev.payload);
});

void init();

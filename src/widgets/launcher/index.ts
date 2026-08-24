import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  buildMenu,
  closeMenus,
  toast,
} from "../../platform/shell";
import { getWindowState, setCollapsed, setPinned } from "../../platform/winstate";
import { registerWidget, type WidgetContext } from "../../platform/registry";
import {
  FALLBACK,
  addApp,
  addFolder,
  addGroup,
  bindRender,
  fetchIcon,
  groupMenu,
  importPaths,
  itemMenu,
  openAppPicker,
} from "./actions";
import {
  loadLauncherData,
  scheduleSave,
  state,
  type Group,
  type Item,
} from "./store";

interface LauncherEls {
  header: HTMLElement;
  search: HTMLInputElement;
  board: HTMLElement;
  pill: HTMLElement;
  pillCount: HTMLElement;
  btnAdd: HTMLButtonElement;
  btnPin: HTMLButtonElement;
  btnCollapse: HTMLButtonElement;
  dropveil: HTMLElement;
  dropTargetName: HTMLElement;
}

let didDrag = false;

function buildDom(root: HTMLElement): LauncherEls {
  root.innerHTML = `
    <header id="header">
      <button id="btn-collapse" class="icon-btn" title="收起为小组件">‹</button>
      <div id="search-wrap">
        <span id="search-icon">⌕</span>
        <input id="search" type="text" placeholder="搜索…" spellcheck="false" />
      </div>
      <button id="btn-add" class="icon-btn" title="添加">＋</button>
      <button id="btn-pin" class="icon-btn" title="钉住置顶">📌</button>
    </header>
    <main id="board"></main>
    <div id="pill" hidden>
      <span id="pill-logo">🐶</span>
      <span id="pill-name">快捷启动</span>
      <span id="pill-count"></span>
    </div>
    <div id="dropveil"><div>松手导入到「<b id="drop-target-name"></b>」</div></div>
  `;
  return {
    header: root.querySelector<HTMLElement>("#header")!,
    search: root.querySelector<HTMLInputElement>("#search")!,
    board: root.querySelector<HTMLElement>("#board")!,
    pill: root.querySelector<HTMLElement>("#pill")!,
    pillCount: root.querySelector<HTMLElement>("#pill-count")!,
    btnAdd: root.querySelector<HTMLButtonElement>("#btn-add")!,
    btnPin: root.querySelector<HTMLButtonElement>("#btn-pin")!,
    btnCollapse: root.querySelector<HTMLButtonElement>("#btn-collapse")!,
    dropveil: root.querySelector<HTMLElement>("#dropveil")!,
    dropTargetName: root.querySelector<HTMLElement>("#drop-target-name")!,
  };
}

let els: LauncherEls | null = null;
let winPinned = false;

function refreshPinVisual(): void {
  if (!els) return;
  els.btnPin.classList.toggle("active", winPinned);
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

function clearDropMarks(): void {
  document
    .querySelectorAll(".drop-target")
    .forEach((el) => el.classList.remove("drop-target"));
  document
    .querySelectorAll(".group-drop")
    .forEach((el) => el.classList.remove("group-drop"));
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
        const other = state.data.items.find(
          (i) => i.id === hit.dataset.id,
        )!;
        const fromIdx = state.data.items.indexOf(item);
        const toIdx = state.data.items.indexOf(other);
        state.data.items.splice(fromIdx, 1);
        const shifted = fromIdx < toIdx ? toIdx - 1 : toIdx;
        state.data.items.splice(shifted, 0, item);
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
    if (!didDrag) {
      void invoke("open_target", { target: item.target }).catch((e) =>
        toast(String(e)),
      );
    }
  };
  tile.oncontextmenu = (ev) => {
    ev.preventDefault();
    itemMenu(ev, item);
  };

  attachPointerDrag(tile, item);
  return tile;
}

export function render(): void {
  if (!els) return;
  closeMenus();
  els.board.innerHTML = "";
  const q = els.search.value.trim().toLowerCase();

  let shown = 0;
  for (const group of state.data.groups) {
    const items = state.data.items.filter(
      (i) => i.groupId === group.id && (!q || i.name.toLowerCase().includes(q)),
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
    els.board.appendChild(section);
  }

  if (shown === 0 && q) {
    els.board.appendChild(emptyHint("没有匹配的结果"));
  } else if (state.data.items.length === 0) {
    els.board.appendChild(emptyHint("把桌面图标或文件夹拖进来"));
  }

  els.pillCount.textContent = `${state.data.items.length} 项`;
  refreshPinVisual();
}

type DropPayload =
  | {
      type: "enter" | "over";
      paths: string[];
      position: { x: number; y: number };
    }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

function clientPos(p: { x: number; y: number }): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: p.x / dpr, y: p.y / dpr };
}

function groupAt(x: number, y: number): Group | undefined {
  const el = document.elementFromPoint(x, y);
  const gid = el?.closest(".group")?.getAttribute("data-gid");
  return state.data.groups.find((g) => g.id === gid) ?? state.data.groups[0];
}

async function mountLauncher(root: HTMLElement): Promise<() => void> {
  els = buildDom(root);
  const e = els;

  await loadLauncherData();
  try {
    const st = await getWindowState();
    winPinned = st.pinned;
    if (st.collapsed) document.body.classList.add("collapsed");
  } catch {
    /* 窗口状态读取失败时使用默认外观 */
  }

  bindRender(render);

  e.search.oninput = () => render();

  e.btnAdd.onclick = (ev) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    buildMenu(rect.left, rect.bottom + 6, [
      { label: "从应用列表添加…", action: openAppPicker },
      {
        label: "添加文件夹…",
        action: () =>
          void addFolder(state.data.groups[0]?.id ?? "").catch(() => {}),
      },
      {
        label: "浏览文件添加…",
        action: () =>
          void addApp(state.data.groups[0]?.id ?? "").catch(() => {}),
      },
      { label: "新建分组…", action: addGroup },
    ]);
  };

  e.btnPin.onclick = () => {
    winPinned = !winPinned;
    refreshPinVisual();
    void setPinned(winPinned);
  };

  e.btnCollapse.onclick = () => {
    document.body.classList.add("collapsed");
    void setCollapsed(true);
  };

  let pillPress: { x: number; y: number } | null = null;

  e.pill.onpointerdown = (ev) => {
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
      void setCollapsed(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  e.header.addEventListener("pointerdown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button,input,#search-wrap")) return;
    void getCurrentWindow().startDragging();
  });

  // 双击标题栏空白处快速收起 / 展开
  e.header.addEventListener("dblclick", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button,input,#search-wrap")) return;
    const collapsed = document.body.classList.toggle("collapsed");
    void setCollapsed(collapsed);
  });

  const unlistenDragDrop = await getCurrentWebview().onDragDropEvent((ev) => {
    const payload = ev.payload as DropPayload;
    if (payload.type === "enter" || payload.type === "over") {
      const pos = clientPos(payload.position);
      const g = groupAt(pos.x, pos.y);
      e.dropTargetName.textContent = g?.name ?? "";
      e.dropveil.classList.add("active");
    } else if (payload.type === "drop") {
      const pos = clientPos(payload.position);
      const g = groupAt(pos.x, pos.y);
      e.dropveil.classList.remove("active");
      if (g && payload.paths.length)
        void importPaths([...payload.paths], g.id);
    } else {
      e.dropveil.classList.remove("active");
    }
  });

  render();

  return () => {
    unlistenDragDrop();
    els = null;
  };
}

registerWidget({
  id: "launcher",
  name: "快捷启动",
  icon: "🐶",
  color: "#ffb84d",
  desc: "桌面快捷方式启动面板，支持分组与拖拽导入",
  width: 340,
  height: 560,
  minWidth: 280,
  minHeight: 96,
  mount: (root: HTMLElement, _ctx: WidgetContext) => mountLauncher(root),
});

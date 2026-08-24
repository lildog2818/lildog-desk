import "./../styles/dashboard.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { allWidgets, type WidgetDef } from "../platform/registry";
import {
  buildMenu,
  closeMenus,
  iconButton,
  toast,
} from "../platform/shell";
import { openAppearanceMenu } from "../platform/appearance";
import {
  closeWidgetWindow,
  openWidgetWindow,
  updateTrayWidgets,
} from "../platform/winstate";
import { widgetLoad, widgetSave } from "../platform/widget-data";

interface DashData {
  hidden: string[];
}

const DEFAULT_DATA: DashData = { hidden: [] };

let saveTimer = 0;
const dashState: { data: DashData; root: HTMLElement | null } = {
  data: { ...DEFAULT_DATA },
  root: null,
};

function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("dashboard", dashState.data);
  }, 200);
}

function visibleWidgets(): WidgetDef[] {
  return allWidgets().filter((w) => !dashState.data.hidden.includes(w.id));
}

async function cardSummary(w: WidgetDef): Promise<string> {
  if (!w.summary) return w.desc;
  try {
    return await w.summary();
  } catch {
    return w.desc;
  }
}

function buildCard(w: WidgetDef): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "wcard";
  card.title = "双击弹出悬浮窗";
  card.style.setProperty("--wc", w.color);

  const icon = document.createElement("div");
  icon.className = "wcard-icon";
  icon.textContent = w.icon;

  const meta = document.createElement("div");
  meta.className = "wcard-meta";
  const name = document.createElement("div");
  name.className = "wcard-name";
  name.textContent = w.name;
  const desc = document.createElement("div");
  desc.className = "wcard-desc";
  desc.textContent = w.desc;
  void cardSummary(w).then((s) => {
    if (desc.isConnected) desc.textContent = s;
  });
  meta.append(name, desc);

  // 悬浮按钮位：关闭该组件的悬浮窗（原"弹出"位）
  const pop = document.createElement("button");
  pop.className = "wcard-pop";
  pop.title = "关闭悬浮窗";
  pop.textContent = "✕";
  pop.onclick = (ev) => {
    ev.stopPropagation();
    void closeWidgetWindow(w.id).catch((e) => toast(String(e)));
  };

  card.append(icon, meta, pop);

  // 双击卡片弹出悬浮窗
  card.ondblclick = () => {
    void openWidgetWindow(w.id, `lildog · ${w.name}`, w.width, w.height).catch(
      (e) => toast(String(e)),
    );
  };
  card.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    buildMenu(ev.clientX, ev.clientY, [
      {
        label: "打开悬浮窗",
        action: () =>
          void openWidgetWindow(
            w.id,
            `lildog · ${w.name}`,
            w.width,
            w.height,
          ).catch((e) => toast(String(e))),
      },
      {
        label: "从控制台隐藏",
        danger: true,
        action: () => {
          dashState.data.hidden.push(w.id);
          persist();
          renderBoard();
        },
      },
    ]);
  };
  return card;
}

function renderBoard(): void {
  const board = dashState.root?.querySelector<HTMLElement>("#board");
  if (!board) return;
  board.innerHTML = "";
  for (const w of visibleWidgets()) board.appendChild(buildCard(w));
  if (visibleWidgets().length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    const dog = document.createElement("span");
    dog.className = "dog";
    dog.textContent = "🧩";
    hint.appendChild(dog);
    hint.appendChild(document.createTextNode("右键面板添加小组件 · 双击卡片弹出悬浮窗"));
    board.appendChild(hint);
  }
}

function syncTray(): void {
  void updateTrayWidgets(
    visibleWidgets().map((w) => ({
      id: w.id,
      title: `${w.icon} ${w.name}`,
    })),
  ).catch(() => {});
}

export async function renderDashboard(root: HTMLElement): Promise<() => void> {
  dashState.data = await widgetLoad<DashData>("dashboard", {
    ...DEFAULT_DATA,
  });
  if (!Array.isArray(dashState.data.hidden)) dashState.data.hidden = [];
  dashState.root = root;

  root.innerHTML = `
    <header id="header" class="home-header">
      <span id="logo">🐶</span>
      <span id="title">控制台</span>
      <span style="flex:1"></span>
    </header>
    <main id="board"></main>
  `;
  const header = root.querySelector<HTMLElement>("#header")!;

  // 组件菜单：面板空白处右键打开（添加/弹出入口）
  const openWidgetMenu = (x: number, y: number): void => {
    const hiddenOnes = allWidgets().filter((w) =>
      dashState.data.hidden.includes(w.id),
    );
    buildMenu(x, y, [
      ...visibleWidgets().map((w) => ({
        label: `${w.icon} ${w.name}`,
        action: () =>
          void openWidgetWindow(
            w.id,
            `lildog · ${w.name}`,
            w.width,
            w.height,
          ).catch((e) => toast(String(e))),
      })),
      ...(hiddenOnes.length ? [{ action: undefined }] : []),
      ...hiddenOnes.map((w) => ({
        label: `${w.icon} 添加「${w.name}」`,
        action: () => {
          dashState.data.hidden = dashState.data.hidden.filter(
            (id) => id !== w.id,
          );
          persist();
          renderBoard();
          syncTray();
        },
      })),
    ]);
  };

  const board = root.querySelector<HTMLElement>("#board")!;
  board.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openWidgetMenu(ev.clientX, ev.clientY);
  });

  // 右上角改为最小化到托盘
  const btnMin = iconButton("最小化", "─");
  btnMin.onclick = () => {
    void getCurrentWindow().hide().catch((e) => toast(String(e)));
  };

  const btnGear = iconButton("设置", "⚙");
  btnGear.onclick = () => {
    const wasOpen = document.querySelector(".opacity-pop");
    closeMenus();
    if (wasOpen) return;
    void openAppearanceMenu(btnGear, true);
  };

  header.append(btnMin, btnGear);
  header.addEventListener("pointerdown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button")) return;
    void getCurrentWindow().startDragging();
  });

  renderBoard();
  syncTray();

  return () => {
    dashState.root = null;
  };
}

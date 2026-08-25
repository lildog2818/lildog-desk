import "./../styles/dashboard.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  getTaskbarEffect,
  openWidgetWindow,
  setTaskbarEffect,
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

/** 任务栏替换当前是否处于应用位（唯一没有悬浮窗、双击即开关的组件） */
const taskbarState = { on: false };

function isTaskbar(w: WidgetDef): boolean {
  return w.id === "taskbar";
}

function taskbarDesc(on: boolean): string {
  return on ? "已应用 · 与小组件同款效果" : "未应用 · 双击立即套用";
}

/** 切换原生任务栏效果：乐观更新卡片显示，失败回滚并提示 */
async function toggleTaskbarEffect(
  card?: HTMLDivElement,
  desc?: HTMLElement,
): Promise<void> {
  const next = !taskbarState.on;
  taskbarState.on = next;
  if (card && desc) paintTaskbarCard(card, desc, next);
  try {
    await setTaskbarEffect(next);
    toast(next ? "🖥️ 已应用任务栏效果" : "已还原系统任务栏");
  } catch (e) {
    taskbarState.on = !next;
    if (card && desc) paintTaskbarCard(card, desc, !next);
    toast(String(e));
  }
}

function paintTaskbarCard(
  card: HTMLDivElement,
  desc: HTMLElement,
  on: boolean,
): void {
  card.classList.toggle("tb-on", on);
  if (desc.isConnected) desc.textContent = taskbarDesc(on);
}

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
  const tb = isTaskbar(w);
  card.className = "wcard";
  card.title = tb ? "双击应用 · 再次双击关闭" : "双击弹出悬浮窗";
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
  if (tb) {
    // 任务栏卡片显示实时开关状态，不拉取摘要
    desc.textContent = taskbarDesc(taskbarState.on);
    card.classList.toggle("tb-on", taskbarState.on);
  } else {
    desc.textContent = w.desc;
    void cardSummary(w).then((s) => {
      if (desc.isConnected) desc.textContent = s;
    });
  }
  meta.append(name, desc);

  // 悬浮按钮位：关闭该组件的悬浮窗 / 关闭任务栏效果
  const pop = document.createElement("button");
  pop.className = "wcard-pop";
  pop.title = tb ? "关闭任务栏效果" : "关闭悬浮窗";
  pop.textContent = "✕";
  pop.onclick = (ev) => {
    ev.stopPropagation();
    if (tb) {
      if (taskbarState.on) void toggleTaskbarEffect(card, desc);
      return;
    }
    void closeWidgetWindow(w.id).catch((e) => toast(String(e)));
  };

  card.append(icon, meta, pop);

  if (tb) {
    // 双击直接应用 / 关闭原生任务栏效果（不弹悬浮窗）
    card.ondblclick = () => void toggleTaskbarEffect(card, desc);
  } else {
    // 双击卡片弹出悬浮窗
    card.ondblclick = () => {
      void openWidgetWindow(w.id, `lildog · ${w.name}`, w.width, w.height).catch(
        (e) => toast(String(e)),
      );
    };
  }
  card.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    buildMenu(ev.clientX, ev.clientY, [
      ...(tb
        ? [
            {
              label: taskbarState.on ? "关闭任务栏效果" : "应用任务栏效果",
              action: () => void toggleTaskbarEffect(card, desc),
            },
          ]
        : [
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
          ]),
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
  // 任务栏是开关型组件（无悬浮窗），不进托盘窗口列表
  void updateTrayWidgets(
    visibleWidgets()
      .filter((w) => !isTaskbar(w))
      .map((w) => ({
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

  // 任务栏开关初始状态 + 跨窗口同步（其他窗口切换时卡片实时刷新）
  taskbarState.on = await getTaskbarEffect().catch(() => false);
  void getCurrentWebview()
    .listen<boolean>("native-bar", (ev) => {
      const next = !!ev.payload;
      if (taskbarState.on === next) return;
      taskbarState.on = next;
      renderBoard();
    })
    .catch(() => {});

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
        action: () => {
          if (isTaskbar(w)) {
            // 任务栏没有悬浮窗：菜单项直接切换效果
            void toggleTaskbarEffect();
          } else {
            void openWidgetWindow(
              w.id,
              `lildog · ${w.name}`,
              w.width,
              w.height,
            ).catch((e) => toast(String(e)));
          }
        },
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

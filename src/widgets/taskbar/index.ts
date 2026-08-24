import "./../../styles/taskbar.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { allWidgets, registerWidget, type WidgetContext } from "../../platform/registry";
import { toast } from "../../platform/shell";
import { closeWidgetWindow, toggleWidgetWindow } from "../../platform/winstate";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { FALLBACK, showAppPicker } from "../launcher/actions";

// ---------------- 数据模型 ----------------

interface Pin {
  id: string;
  name: string;
  kind: string;
  target: string;
  args?: string | null;
  /** 图标 PNG 路径（get_icon 结果），懒取后回存 */
  icon?: string | null;
  /** 运行态匹配用 exe 路径（lnk 已解析内层目标；空串=不参与匹配） */
  exe?: string | null;
}

interface BarData {
  pins: Pin[];
}

const DEFAULT_DATA: BarData = { pins: [] };

interface TaskWindowInfo {
  hwnd: number;
  title: string;
  exe: string;
  minimized: boolean;
}

interface TaskListPayload {
  windows: TaskWindowInfo[];
  foreground: number;
}

// ---------------- 状态 ----------------

let data: BarData = { ...DEFAULT_DATA };
let tasks: TaskWindowInfo[] = [];
let foregroundHwnd = 0;
let hideSystemBar = false;

interface TbEls {
  wrap: HTMLElement;
  flyout: HTMLElement;
  pins: HTMLElement;
  widgets: HTMLElement;
  tasks: HTMLElement;
  clock: HTMLElement;
  time: HTMLElement;
  date: HTMLElement;
}
let els: TbEls | null = null;
let flyoutOpen = false;
let unlistenMenu: (() => void) | null = null;

let saveTimer = 0;
let clockTimer = 0;
let pollTimer = 0;
const iconPending = new Set<string>();
const taskIcons = new Map<string, string>();
const taskIconPending = new Set<string>();
const taskButtons = new Map<number, HTMLButtonElement>();

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("taskbar", data).catch(() => {});
  }, 250);
}

const normPath = (s?: string | null): string => (s ?? "").trim().toLowerCase();

/** 固定项是否正在运行：按解析出的 exe 路径与运行窗口列表匹配 */
function isPinRunning(pin: Pin): boolean {
  const exe = normPath(pin.exe);
  if (!exe) return false;
  return tasks.some((t) => t.exe && normPath(t.exe) === exe);
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

// ---------------- Flyout（向上展开区，承载日历/选应用） ----------------

async function openFlyout(build: (box: HTMLElement) => void): Promise<void> {
  if (!els || flyoutOpen) return;
  flyoutOpen = true;
  els.flyout.innerHTML = "";
  const box = document.createElement("div");
  box.className = "tb-flyout-box";
  els.flyout.appendChild(box);
  els.flyout.hidden = false;
  try {
    await invoke("set_taskbar_expanded", { expanded: true });
  } catch (e) {
    toast(String(e));
  }
  // 点击展开区空白处或 Esc 时收起；时钟自身除外（由其 click 处理开合，
  // 否则 pointerdown 先收起、click 又展开，表现为"关不掉"）
  const dismiss = (ev: Event): void => {
    if (ev.type === "keydown" && (ev as KeyboardEvent).key !== "Escape") return;
    const t = ev.target as HTMLElement;
    if (
      ev.type === "pointerdown" &&
      (t.closest(".tb-flyout-box") || t.closest("#tb-clock"))
    ) {
      return;
    }
    void closeFlyout();
  };
  els.wrap.addEventListener("pointerdown", dismiss);
  window.addEventListener("keydown", dismiss);
  (els.wrap as TbWrap)._tbDismiss = dismiss;
  build(box);
}

interface TbWrap extends HTMLElement {
  _tbDismiss?: ((ev: Event) => void) | null;
}

async function closeFlyout(): Promise<void> {
  if (!els || !flyoutOpen) return;
  flyoutOpen = false;
  const dismiss = (els.wrap as TbWrap)._tbDismiss;
  if (dismiss) {
    els.wrap.removeEventListener("pointerdown", dismiss);
    window.removeEventListener("keydown", dismiss);
    (els.wrap as TbWrap)._tbDismiss = null;
  }
  els.flyout.hidden = true;
  els.flyout.innerHTML = "";
  try {
    await invoke("set_taskbar_expanded", { expanded: false });
  } catch {
    /* 收起失败不影响使用 */
  }
}

/** 选应用对话框在展开区内完成；浮层消失后自动收起 */
function openPickerFlyout(): void {
  void openFlyout(() => {
    showAppPicker({
      isAdded: (target) =>
        data.pins.some((p) => p.target.toLowerCase() === target.toLowerCase()),
      onPick: (a) => {
        const pin: Pin = {
          id: uid(),
          name: a.name,
          kind: a.kind,
          target: a.target,
          args: a.args,
          icon: null,
          exe: null,
        };
        data.pins.push(pin);
        scheduleSave();
        renderPins();
        // 解析运行态 exe（lnk 内层目标），供「正在运行」点亮
        void invoke<{ name: string; exe: string }>("resolve_pin_target", {
          path: a.target,
        })
          .then((r) => {
            if (r?.exe) {
              pin.exe = r.exe;
              scheduleSave();
              refreshPinsRunning();
            }
          })
          .catch(() => {});
      },
    });
    // 观察全局浮层：用户关闭选框后收起展开区
    const mo = new MutationObserver(() => {
      if (!document.querySelector(".overlay")) {
        mo.disconnect();
        void closeFlyout();
      }
    });
    mo.observe(document.body, { childList: true });
  });
}

function openCalendarFlyout(): void {
  void openFlyout((box) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const head = document.createElement("div");
    head.className = "tb-cal-head";
    head.textContent = `${year}年${month + 1}月`;

    const grid = document.createElement("div");
    grid.className = "tb-cal-grid";
    for (const w of ["日", "一", "二", "三", "四", "五", "六"]) {
      const c = document.createElement("span");
      c.className = "tb-cal-wd";
      c.textContent = w;
      grid.appendChild(c);
    }
    const firstDay = new Date(year, month, 1).getDay();
    for (let i = 0; i < firstDay; i++) {
      grid.appendChild(document.createElement("span"));
    }
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const c = document.createElement("span");
      c.className = "tb-cal-day";
      if (d === now.getDate()) c.classList.add("today");
      c.textContent = String(d);
      grid.appendChild(c);
    }

    box.classList.add("cal");
    box.append(head, grid);
  });
}

// ---------------- 原生右键菜单 ----------------

/**
 * 右键菜单用系统原生弹出（muda），不受本窗口高度裁剪；
 * 菜单事件统一以 "tb-*" id 经后端转发回 "tb-menu"，前端集中分发。
 */
function showNativeMenu(
  kind: "pin" | "task" | "bar",
  opts: { id?: string; title?: string; hwnd?: number } = {},
): void {
  void invoke("show_tb_menu", {
    kind,
    id: opts.id ?? "",
    title: opts.title ?? "",
    hwnd: opts.hwnd ?? 0,
  }).catch((e) => toast(String(e)));
}

function handleMenuId(raw: string): void {
  if (raw.startsWith("tb-pin-open:")) {
    const pin = data.pins.find((p) => p.id === raw.slice(12));
    if (pin)
      void invoke("open_target", { target: pin.target }).catch((e) =>
        toast(String(e)),
      );
  } else if (raw.startsWith("tb-pin-reveal:")) {
    const pin = data.pins.find((p) => p.id === raw.slice(14));
    if (pin)
      void invoke("reveal_target", { target: pin.target }).catch((e) =>
        toast(String(e)),
      );
  } else if (raw.startsWith("tb-pin-unpin:")) {
    const pid = raw.slice(13);
    data.pins = data.pins.filter((p) => p.id !== pid);
    scheduleSave();
    renderPins();
  } else if (raw.startsWith("tb-task-min:")) {
    const hwnd = Number(raw.slice(12));
    void invoke("minimize_task_window", { hwnd })
      .then(refreshSoon)
      .catch(() => {});
  } else if (raw.startsWith("tb-task-close:")) {
    const hwnd = Number(raw.slice(14));
    void invoke("close_task_window", { hwnd })
      .then(refreshSoon)
      .catch((e) => toast(String(e)));
  } else if (raw === "tb-bar-addpin") {
    openPickerFlyout();
  } else if (raw === "tb-bar-togglesys") {
    toggleHideSystem();
  } else if (raw === "tb-bar-close") {
    void closeFlyout().finally(() => {
      void closeWidgetWindow("taskbar").catch((e) => toast(String(e)));
    });
  }
}

// ---------------- 时钟 ----------------

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function tickClock(): void {
  if (!els) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  els.time.textContent = `${hh}:${mm}`;
  els.date.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${
    WEEKDAYS[d.getDay()]
  }`;
}

// ---------------- 图标 ----------------

async function fetchPinIcon(pin: Pin): Promise<void> {
  const key = pin.target.toLowerCase();
  if (iconPending.has(key)) return;
  iconPending.add(key);
  try {
    const p = await invoke<string>("get_icon", { path: pin.target });
    if (p) {
      pin.icon = p;
      scheduleSave();
      renderPins();
    }
  } catch {
    /* 取不到图标就保留兜底字形 */
  } finally {
    iconPending.delete(key);
  }
}

function ensureTaskIcon(btn: HTMLButtonElement, t: TaskWindowInfo): void {
  const ic = btn.querySelector<HTMLElement>(".tb-task-icon");
  if (!ic || ic.querySelector("img")) return;
  const key = normPath(t.exe);
  if (!key) return; // 无路径（如提权进程）保持通用字形
  const cached = taskIcons.get(key);
  if (cached === undefined) {
    if (taskIconPending.has(key)) return;
    taskIconPending.add(key);
    void invoke<string>("get_icon", { path: t.exe })
      .then((p) => {
        taskIconPending.delete(key);
        taskIcons.set(key, p ?? "");
        if (p) renderTasks();
      })
      .catch(() => {
        taskIconPending.delete(key);
        taskIcons.set(key, "");
      });
    return;
  }
  if (cached) {
    ic.innerHTML = "";
    const img = document.createElement("img");
    img.src = convertFileSrc(cached);
    img.draggable = false;
    img.alt = "";
    ic.appendChild(img);
  }
}

// ---------------- 渲染 ----------------

function pinEl(pin: Pin): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tb-btn tb-pin";
  b.dataset.id = pin.id;
  b.title = pin.name;

  if (pin.icon) {
    const img = document.createElement("img");
    img.src = convertFileSrc(pin.icon);
    img.draggable = false;
    img.alt = "";
    b.appendChild(img);
  } else {
    const fb = document.createElement("span");
    fb.className = "tb-fallback";
    fb.innerHTML = FALLBACK[pin.kind] ?? FALLBACK.file;
    b.appendChild(fb);
    void fetchPinIcon(pin);
  }

  b.onclick = () => {
    void invoke("open_target", { target: pin.target }).catch((e) =>
      toast(String(e)),
    );
  };
  b.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showNativeMenu("pin", { id: pin.id, title: pin.name });
  };
  return b;
}

function renderPins(): void {
  if (!els) return;
  els.pins.innerHTML = "";
  for (const pin of data.pins) {
    const b = pinEl(pin);
    b.classList.toggle("running", isPinRunning(pin));
    els.pins.appendChild(b);
  }
}

function refreshPinsRunning(): void {
  if (!els) return;
  for (const pin of data.pins) {
    const b = els.pins.querySelector<HTMLButtonElement>(
      `.tb-pin[data-id="${pin.id}"]`,
    );
    if (b) b.classList.toggle("running", isPinRunning(pin));
  }
}

function renderWidgets(): void {
  if (!els) return;
  els.widgets.innerHTML = "";
  for (const w of allWidgets()) {
    if (w.id === "taskbar") continue;
    const b = document.createElement("button");
    b.className = "tb-btn";
    b.textContent = w.icon;
    b.title = `${w.name}`;
    b.onclick = () => {
      void toggleWidgetWindow(
        w.id,
        `lildog · ${w.name}`,
        w.width,
        w.height,
      ).catch((e) => toast(String(e)));
    };
    els.widgets.appendChild(b);
  }
}

function makeTaskButton(t: TaskWindowInfo): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tb-btn tb-task";
  const ic = document.createElement("span");
  ic.className = "tb-task-icon";
  ic.innerHTML = FALLBACK.app;
  const lb = document.createElement("span");
  lb.className = "tb-label";
  b.append(ic, lb);

  const hwnd = t.hwnd;
  b.onclick = () => {
    void invoke("activate_task_window", { hwnd })
      .then(refreshSoon)
      .catch((e) => toast(String(e)));
  };
  b.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showNativeMenu("task", { hwnd, title: t.title });
  };
  return b;
}

/** 按 hwnd 键控 diff 更新任务按钮，避免整段重建破坏 hover 态 */
function renderTasks(): void {
  if (!els) return;
  const seen = new Set<number>();
  for (const t of tasks) {
    seen.add(t.hwnd);
    let b = taskButtons.get(t.hwnd);
    if (!b) {
      b = makeTaskButton(t);
      taskButtons.set(t.hwnd, b);
      els.tasks.appendChild(b);
    }
    const lb = b.querySelector<HTMLElement>(".tb-label")!;
    if (lb.textContent !== t.title) {
      lb.textContent = t.title;
      b.title = t.title;
    }
    ensureTaskIcon(b, t);
    b.classList.toggle("active", foregroundHwnd === t.hwnd && !t.minimized);
    b.classList.toggle("mined", t.minimized);
  }
  for (const [hwnd, b] of [...taskButtons]) {
    if (!seen.has(hwnd)) {
      b.remove();
      taskButtons.delete(hwnd);
    }
  }
}

// ---------------- 数据刷新 ----------------

async function refreshTasks(): Promise<void> {
  try {
    const r = await invoke<TaskListPayload>("list_task_windows");
    tasks = Array.isArray(r?.windows) ? r.windows : [];
    foregroundHwnd = r?.foreground ?? 0;
    renderTasks();
    refreshPinsRunning();
  } catch {
    /* 后端暂时不可用时静默，下个周期重试 */
  }
}

function refreshSoon(): void {
  window.setTimeout(() => void refreshTasks(), 120);
}

async function loadHideSystem(): Promise<void> {
  try {
    hideSystemBar = await invoke<boolean>("get_hide_system_bar");
  } catch {
    hideSystemBar = false;
  }
}

function toggleHideSystem(): void {
  const next = !hideSystemBar;
  hideSystemBar = next;
  void invoke("set_hide_system_bar", { on: next }).catch((e) => {
    hideSystemBar = !next;
    toast(String(e));
  });
}

// ---------------- 挂载 ----------------

async function mountTaskbar(root: HTMLElement): Promise<() => void> {
  document.body.classList.add("tb-body");

  data = await widgetLoad<BarData>("taskbar", { ...DEFAULT_DATA });
  if (!Array.isArray(data.pins)) data.pins = [];

  root.innerHTML = `
    <div id="tb-wrap">
      <div id="tb-flyout" hidden></div>
      <div id="tb-bar">
        <button id="tb-start" title="控制台">🐶</button>
        <div id="tb-pins" class="tb-strip"></div>
        <div class="tb-sep"></div>
        <div id="tb-widgets" class="tb-strip"></div>
        <div class="tb-sep"></div>
        <div id="tb-tasks" class="tb-strip tb-grow"></div>
        <div id="tb-right">
          <div id="tb-clock" title="日历">
            <div id="tb-time">--:--</div>
            <div id="tb-date"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  els = {
    wrap: root.querySelector<HTMLElement>("#tb-wrap")!,
    flyout: root.querySelector<HTMLElement>("#tb-flyout")!,
    pins: root.querySelector<HTMLElement>("#tb-pins")!,
    widgets: root.querySelector<HTMLElement>("#tb-widgets")!,
    tasks: root.querySelector<HTMLElement>("#tb-tasks")!,
    clock: root.querySelector<HTMLElement>("#tb-clock")!,
    time: root.querySelector<HTMLElement>("#tb-time")!,
    date: root.querySelector<HTMLElement>("#tb-date")!,
  };

  const startBtn = root.querySelector<HTMLButtonElement>("#tb-start")!;
  startBtn.onclick = () => {
    void invoke("toggle_main").catch((e) => toast(String(e)));
  };

  els.clock.onclick = () => {
    if (flyoutOpen) void closeFlyout();
    else openCalendarFlyout();
  };

  // 任务栏空白处右键 → 原生设置菜单（避开 pin/task 自身的右键）
  els.tasks.addEventListener("contextmenu", (ev) => {
    if ((ev.target as HTMLElement).closest(".tb-task")) return;
    ev.preventDefault();
    showNativeMenu("bar");
  });

  // 原生菜单事件回环：后端把被点中的菜单项 id 原样转发回来
  unlistenMenu = await getCurrentWebview()
    .listen<string>("tb-menu", (ev) => handleMenuId(ev.payload))
    .catch(() => null);

  renderPins();
  renderWidgets();
  tickClock();
  await loadHideSystem();
  await refreshTasks();

  clockTimer = window.setInterval(tickClock, 1000);
  pollTimer = window.setInterval(() => void refreshTasks(), 1500);

  return () => {
    window.clearInterval(clockTimer);
    window.clearInterval(pollTimer);
    unlistenMenu?.();
    void closeFlyout();
    document.body.classList.remove("tb-body");
    taskButtons.clear();
    els = null;
  };
}

registerWidget({
  id: "taskbar",
  name: "任务栏",
  icon: "🧭",
  color: "#7dd3fc",
  desc: "屏幕底部停靠任务栏，替代系统任务栏",
  width: 900,
  height: 56,
  minWidth: 320,
  minHeight: 56,
  mount: (root: HTMLElement, _ctx: WidgetContext) => mountTaskbar(root),
});

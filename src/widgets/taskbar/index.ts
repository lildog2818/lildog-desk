import "./../../styles/taskbar.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { registerWidget, type WidgetContext } from "../../platform/registry";
import { toast } from "../../platform/shell";
import { closeWidgetWindow } from "../../platform/winstate";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { FALLBACK } from "../launcher/actions";

// ---------------- 数据模型 ----------------

export interface Pin {
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

export interface BarData {
  pins: Pin[];
}

export const VOL_ICON = {
  on: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

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
let audioMuted = false;
let audioVolume = 0.5;

interface TbEls {
  wrap: HTMLElement;
  pins: HTMLElement;
  tasks: HTMLElement;
  net: HTMLButtonElement;
  vol: HTMLButtonElement;
  time: HTMLElement;
  date: HTMLElement;
}
let els: TbEls | null = null;
let unlistenFns: Array<() => void> = [];

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

// ---------------- 音量（滚轮调节 / 面板滑条） ----------------

function renderVolIcon(): void {
  if (!els) return;
  els.vol.innerHTML = audioMuted ? VOL_ICON.off : VOL_ICON.on;
  els.vol.classList.toggle("muted", audioMuted);
  els.vol.title = audioMuted
    ? `已静音（音量 ${Math.round(audioVolume * 100)}%）`
    : `音量 ${Math.round(audioVolume * 100)}%，点击静音，滚轮调节`;
}

async function loadAudioState(): Promise<void> {
  try {
    const st = await invoke<{ volume: number; muted: boolean }>(
      "get_audio_state",
    );
    audioVolume = st.volume;
    audioMuted = st.muted;
    renderVolIcon();
  } catch {
    /* 取不到就保持默认外观 */
  }
}

let volSyncTimer = 0;
function adjustVolume(delta: number): void {
  audioVolume = Math.min(1, Math.max(0, audioVolume + delta));
  renderVolIcon();
  window.clearTimeout(volSyncTimer);
  volSyncTimer = window.setTimeout(() => {
    void invoke("set_audio_volume", { volume: audioVolume }).catch(() => {});
  }, 60);
}

// ---------------- 原生右键菜单（锚定在栏外，防止误点菜单项） ----------------

function showNativeMenu(
  kind: "pin" | "task" | "bar",
  opts: { id?: string; title?: string; hwnd?: number; cx?: number; cy?: number } = {},
): void {
  void invoke("show_tb_menu", {
    kind,
    id: opts.id ?? "",
    title: opts.title ?? "",
    hwnd: opts.hwnd ?? 0,
    cx: opts.cx ?? 0,
    cy: opts.cy ?? 0,
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
    void invoke("open_taskbar_panel", { mode: "picker" }).catch((e) =>
      toast(String(e)),
    );
  } else if (raw === "tb-bar-close") {
    void closeWidgetWindow("taskbar").catch((e) => toast(String(e)));
  }
}

// ---------------- 网络（状态展示 + 跳转系统设置） ----------------

const NET_ICON =
  '<svg viewBox="0 0 24 24"><path d="M12 19.6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8.4 14.4a5.2 5.2 0 0 1 7.2 0M5.4 11.3a9.4 9.4 0 0 1 13.2 0M2.5 8.2a13.6 13.6 0 0 1 19 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function renderNetIcon(st: { online: boolean; name: string; kind: string }): void {
  if (!els) return;
  els.net.innerHTML = NET_ICON;
  els.net.classList.toggle("offline", !st.online);
  els.net.title = st.online
    ? `${st.kind === "wifi" ? "Wi-Fi" : "网络"}：${st.name || "已连接"}（点击打开网络设置）`
    : "网络：未连接（点击打开网络设置）";
}

async function loadNetwork(): Promise<void> {
  try {
    renderNetIcon(
      await invoke<{ online: boolean; name: string; kind: string }>(
        "get_network_status",
      ),
    );
  } catch {
    /* 静默，下个周期重试 */
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
  const ic = btn.querySelector<HTMLElement>(".tb-ico");
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
    fb.className = "tb-ico";
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
    showNativeMenu("pin", {
      id: pin.id,
      title: pin.name,
      cx: ev.clientX,
      cy: ev.clientY,
    });
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

function makeTaskButton(t: TaskWindowInfo): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tb-btn tb-task";
  b.title = t.title;
  const ic = document.createElement("span");
  ic.className = "tb-ico";
  ic.innerHTML = FALLBACK.app;
  b.append(ic);

  const hwnd = t.hwnd;
  b.onclick = () => {
    void invoke("activate_task_window", { hwnd })
      .then(refreshSoon)
      .catch((e) => toast(String(e)));
  };
  b.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showNativeMenu("task", {
      hwnd,
      title: t.title,
      cx: ev.clientX,
      cy: ev.clientY,
    });
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
    if (b.title !== t.title) b.title = t.title;
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

// ---------------- 挂载 ----------------

async function mountTaskbar(root: HTMLElement): Promise<() => void> {
  document.body.classList.add("tb-body");

  data = await widgetLoad<BarData>("taskbar", { ...DEFAULT_DATA });
  if (!Array.isArray(data.pins)) data.pins = [];

  root.innerHTML = `
    <div id="tb-wrap">
      <div id="tb-center">
        <div id="tb-pins" class="tb-strip"></div>
        <div class="tb-sep"></div>
        <div id="tb-tasks" class="tb-strip"></div>
      </div>
      <div id="tb-right">
        <button id="tb-net" class="tb-btn sys" title="网络"></button>
        <button id="tb-vol" class="tb-btn sys" title="音量"></button>
        <div id="tb-clock">
          <div id="tb-time">--:--</div>
          <div id="tb-date"></div>
        </div>
      </div>
    </div>
  `;

  els = {
    wrap: root.querySelector<HTMLElement>("#tb-wrap")!,
    pins: root.querySelector<HTMLElement>("#tb-pins")!,
    tasks: root.querySelector<HTMLElement>("#tb-tasks")!,
    net: root.querySelector<HTMLButtonElement>("#tb-net")!,
    vol: root.querySelector<HTMLButtonElement>("#tb-vol")!,
    time: root.querySelector<HTMLElement>("#tb-time")!,
    date: root.querySelector<HTMLElement>("#tb-date")!,
  };

  // 空白处按住拖动窗口（按钮/时钟除外）
  els.wrap.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    if (t.closest("button,input")) return;
    void getCurrentWindow().startDragging();
  });

  // 右键空白处 → 栏菜单（锚定在栏外）
  els.wrap.addEventListener("contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".tb-pin,.tb-task")) return;
    ev.preventDefault();
    showNativeMenu("bar", { cx: ev.clientX, cy: ev.clientY });
  });

  // 网络图标：点击弹出快捷设置面板；状态随轮询低频刷新
  els.net.addEventListener("click", () => {
    void invoke("open_taskbar_panel", { mode: "settings" }).catch((e) =>
      toast(String(e)),
    );
  });

  // 音量图标：点击弹出快捷设置面板（滑条调节），滚轮快速增减
  els.vol.addEventListener("click", () => {
    void invoke("open_taskbar_panel", { mode: "settings" }).catch((e) =>
      toast(String(e)),
    );
  });
  els.vol.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    adjustVolume(ev.deltaY < 0 ? 0.05 : -0.05);
  });

  // 原生菜单事件回环：后端把被点中的菜单项 id 原样转发回来；
  // 面板（picker 模式）修改固定项后同步刷新
  unlistenFns.push(
    await getCurrentWebview()
      .listen<string>("tb-menu", (ev) => handleMenuId(ev.payload))
      .catch(() => () => {}),
  );
  unlistenFns.push(
    await getCurrentWebview().listen("tb-pins-changed", () => {
      void widgetLoad<BarData>("taskbar", { ...DEFAULT_DATA }).then((d) => {
        if (!Array.isArray(d.pins)) d.pins = [];
        data = d;
        renderPins();
      });
    }),
  );

  renderPins();
  renderVolIcon();
  renderNetIcon({ online: true, name: "", kind: "none" });
  tickClock();
  void loadAudioState();
  void loadNetwork();
  await refreshTasks();

  let netTick = 0;
  clockTimer = window.setInterval(tickClock, 1000);
  pollTimer = window.setInterval(() => {
    void refreshTasks();
    // 网络状态约每 6 秒刷新一次
    if (++netTick % 4 === 0) void loadNetwork();
  }, 1500);

  return () => {
    window.clearInterval(clockTimer);
    window.clearInterval(pollTimer);
    for (const fn of unlistenFns) fn();
    unlistenFns = [];
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
  desc: "系统任务栏风格：图标居中、音量与网络、运行中窗口",
  width: 880,
  height: 72,
  minWidth: 320,
  minHeight: 72,
  mount: (root: HTMLElement, _ctx: WidgetContext) => mountTaskbar(root),
});

import { getWindowState, setPinned } from "../../platform/winstate";
import { registerWidget } from "../../platform/registry";
import {
  button,
  closeOverlays,
  field,
  modal,
  toast,
} from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/pomodoro.css";

type Mode = "focus" | "short" | "long";

interface PomodoroData {
  focusMin: number;
  shortMin: number;
  longMin: number;
  longEvery: number;
  mode: Mode;
  running: boolean;
  /** 运行中的截止时刻（毫秒时间戳）；暂停时为 null */
  endAt: number | null;
  /** 暂停时保存的剩余秒数；未运行且未修改时作为当前剩余 */
  remaining: number;
  /** 本轮循环中已完成的专注数（达到 longEvery 后回到 0） */
  cycle: number;
  /** 当日已完成番茄数（跨天自动清零） */
  date: string;
  todayCount: number;
}

const DEFAULT_DATA: PomodoroData = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  mode: "focus",
  running: false,
  endAt: null,
  remaining: 25 * 60,
  cycle: 0,
  date: "",
  todayCount: 0,
};

const MODE_META: Record<
  Mode,
  { label: string; color: string; status: string }
> = {
  focus: { label: "专注", color: "#ff6347", status: "专注中" },
  short: { label: "短休息", color: "#34d399", status: "短休息中" },
  long: { label: "长休息", color: "#60a5fa", status: "长休息中" },
};

function durationOf(d: PomodoroData, mode: Mode): number {
  const min =
    mode === "focus" ? d.focusMin : mode === "short" ? d.shortMin : d.longMin;
  return Math.max(1, Math.round(min)) * 60;
}

function today(): string {
  const n = new Date();
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

let data: PomodoroData = { ...DEFAULT_DATA };
let saveTimer = 0;

function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("pomodoro", structuredClone(data));
  }, 250);
}

/** 轻量计时器：基于截止时刻重算剩余，Webview 被节流时仍然准确 */
let tickTimer = 0;

function renderTick(): void {
  if (!data.running || data.endAt === null) return;
  const left = Math.max(0, Math.ceil((data.endAt - Date.now()) / 1000));
  const changed = left !== data.remaining;
  data.remaining = left;
  if (changed) paintRemaining();
  if (left <= 0) {
    completePhase();
    paint();
  }
}

function startTick(): void {
  window.clearInterval(tickTimer);
  tickTimer = window.setInterval(renderTick, 250);
}

function stopTick(): void {
  window.clearInterval(tickTimer);
}

function start(): void {
  if (data.remaining <= 0) data.remaining = durationOf(data, data.mode);
  data.endAt = Date.now() + data.remaining * 1000;
  data.running = true;
  persist();
  startTick();
  paint();
}

function pause(): void {
  data.running = false;
  data.endAt = null;
  persist();
  stopTick();
  paint();
}

/** 重置当前阶段计时（停止） */
function reset(): void {
  data.running = false;
  data.endAt = null;
  data.remaining = durationOf(data, data.mode);
  persist();
  stopTick();
  paint();
}

/** 跳过当前阶段：不计数，直接进入下一阶段并暂停 */
function skip(): void {
  data.running = false;
  data.endAt = null;
  const next = nextMode(data.mode);
  data.mode = next;
  data.remaining = durationOf(data, next);
  persist();
  stopTick();
  paint();
  toast(`已跳到${nextLabel(data.mode)} · 点击「开始」启动`);
}

function nextLabel(mode: Mode): string {
  return MODE_META[mode].label;
}

function nextMode(mode: Mode): Mode {
  if (mode === "focus") {
    const n = data.cycle % Math.max(1, data.longEvery);
    return n === 0 && data.cycle > 0 ? "long" : "short";
  }
  return "focus";
}

/** 一个阶段自然结束：专注结束计数并进入休息；休息结束回到专注。均暂停待开始 */
function completePhase(): void {
  const finished = data.mode;
  if (finished === "focus") {
    data.cycle += 1;
    if (data.date !== today()) {
      data.date = today();
      data.todayCount = 0;
    }
    data.todayCount += 1;
  }
  const next = nextMode(finished);
  data.mode = next;
  data.running = false;
  data.endAt = null;
  data.remaining = durationOf(data, next);
  persist();
  const msg =
    finished === "focus"
      ? `🍅 第 ${data.todayCount} 个番茄完成，开始${nextLabel(next)}（${Math.round(data.remaining / 60)} 分钟）`
      : `休息结束，开始${nextLabel(next)}（${Math.round(data.remaining / 60)} 分钟）`;
  toast(msg);
  beep(finished === "focus" ? 3 : 2);
}

// ---------------- 提示音（Web Audio，随开始键的用户手势解锁） ----------------

let audioCtx: AudioContext | null = null;

function ensureAudio(): void {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
  } catch {
    audioCtx = null;
  }
}

function beep(times: number): void {
  ensureAudio();
  if (!audioCtx) return;
  void audioCtx.resume().catch(() => {});
  const now = audioCtx.currentTime;
  for (let i = 0; i < times; i++) {
    const t = now + i * 0.34;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    // 轻微升调的双音提示
    osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 660, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}

// ---------------- 渲染 ----------------

interface PomodoroEls {
  root: HTMLElement;
  tabs: Record<Mode, HTMLButtonElement>;
  time: HTMLDivElement;
  status: HTMLDivElement;
  dots: HTMLDivElement;
  btnStart: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnSkip: HTMLButtonElement;
  footer: HTMLDivElement;
  ring: SVGCircleElement;
  ringLen: number;
}

let els: PomodoroEls | null = null;

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function setModeColor(mode: Mode): void {
  els?.root.style.setProperty("--pm-c", MODE_META[mode].color);
}

function paintRemaining(): void {
  if (!els) return;
  const total = durationOf(data, data.mode);
  const frac = Math.max(0, Math.min(1, data.remaining / total));
  els.ring.style.strokeDashoffset = String(els.ringLen * (1 - frac));
  els.time.textContent = fmtTime(data.remaining);
}

function cycleInRun(): number {
  const c = data.cycle % data.longEvery;
  return c === 0 && data.cycle > 0 ? data.longEvery : c;
}

function paint(): void {
  if (!els) return;
  const e = els;
  const meta = MODE_META[data.mode];
  setModeColor(data.mode);

  for (const m of ["focus", "short", "long"] as const) {
    e.tabs[m].classList.toggle("on", m === data.mode);
  }

  paintRemaining();

  if (data.running) {
    e.status.textContent =
      data.mode === "focus"
        ? `专注中 · 第 ${Math.min(cycleInRun() + 1, data.longEvery)}/${data.longEvery} 个番茄`
        : `${meta.status} · 已完成 ${cycleInRun()}/${data.longEvery} 个番茄`;
  } else if (data.remaining < durationOf(data, data.mode)) {
    e.status.textContent = `「${meta.label}」已暂停`;
  } else {
    e.status.textContent = `点击开始「${meta.label}」`;
  }

  // 本轮循环进度圆点
  e.dots.innerHTML = "";
  const done = data.cycle % data.longEvery;
  const shown = Math.max(2, Math.min(8, data.longEvery));
  for (let i = 0; i < shown; i++) {
    const dot = document.createElement("span");
    dot.className = "pm-dot";
    dot.textContent = i < done ? "🍅" : "·";
    if (i < done) dot.classList.add("done");
    e.dots.appendChild(dot);
  }

  e.btnStart.textContent = data.running ? "暂停" : data.remaining <= 0 ? "开始" : "继续";
  e.btnStart.classList.toggle("running", data.running);

  e.footer.textContent = `今日已完成 ${data.todayCount} 个番茄`;
}

function openSettings(): void {
  const focusMin = document.createElement("input");
  focusMin.type = "number";
  focusMin.min = "1";
  focusMin.max = "180";
  focusMin.value = String(data.focusMin);
  const shortMin = document.createElement("input");
  shortMin.type = "number";
  shortMin.min = "1";
  shortMin.max = "60";
  shortMin.value = String(data.shortMin);
  const longMin = document.createElement("input");
  longMin.type = "number";
  longMin.min = "1";
  longMin.max = "120";
  longMin.value = String(data.longMin);
  const longEvery = document.createElement("input");
  longEvery.type = "number";
  longEvery.min = "2";
  longEvery.max = "8";
  longEvery.value = String(data.longEvery);

  const clamp = (input: HTMLInputElement, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.round(Number(input.value) || lo)));

  modal("番茄钟设置", [
    field("专注时长（分钟）", focusMin),
    field("短休息（分钟）", shortMin),
    field("长休息（分钟）", longMin),
    field("每几个专注后长休息", longEvery),
  ], [
    button("取消", "", () => closeOverlays()),
    button("保存", "primary", () => {
      const running = data.running;
      data.focusMin = clamp(focusMin, 1, 180);
      data.shortMin = clamp(shortMin, 1, 60);
      data.longMin = clamp(longMin, 1, 120);
      data.longEvery = clamp(longEvery, 2, 8);
      if (running) pause();
      data.remaining = durationOf(data, data.mode);
      persist();
      paint();
    }),
  ]);
}

function mountPomodoro(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "🍅", "番茄钟");
  // 番茄钟无刷新需求，仅保留设置与固定
  shell.btnRefresh.remove();

  const body = shell.body;
  body.classList.add("pm-body");

  // 模式切换
  const tabs = document.createElement("div");
  tabs.className = "pm-tabs";
  const tabBtns = {} as Record<Mode, HTMLButtonElement>;
  for (const m of ["focus", "short", "long"] as const) {
    const b = document.createElement("button");
    b.className = "pm-tab";
    b.dataset.mode = m;
    b.textContent = MODE_META[m].label;
    b.onclick = () => {
      if (data.mode === m) return;
      data.running = false;
      data.endAt = null;
      data.mode = m;
      data.remaining = durationOf(data, m);
      persist();
      stopTick();
      paint();
    };
    tabBtns[m] = b;
    tabs.appendChild(b);
  }

  // 环形倒计时
  const ringWrap = document.createElement("div");
  ringWrap.className = "pm-ring-wrap";
  const R = 84;
  const ringLen = 2 * Math.PI * R;
  ringWrap.innerHTML = `
    <svg class="pm-ring" width="190" height="190" viewBox="0 0 190 190">
      <circle class="pm-ring-bg" cx="95" cy="95" r="${R}" />
      <circle class="pm-ring-fg" cx="95" cy="95" r="${R}" />
    </svg>`;
  const ring = ringWrap.querySelector<SVGCircleElement>(".pm-ring-fg")!;
  ring.style.strokeDasharray = String(ringLen);
  const time = document.createElement("div");
  time.className = "pm-time";
  const status = document.createElement("div");
  status.className = "pm-status";
  ringWrap.append(time, status);

  // 进度圆点
  const dots = document.createElement("div");
  dots.className = "pm-dots";

  // 控制按钮
  const controls = document.createElement("div");
  controls.className = "pm-controls";
  const btnStart = button("开始", "primary pm-start");
  const btnReset = document.createElement("button");
  btnReset.className = "pm-round";
  btnReset.title = "重新开始本阶段";
  btnReset.textContent = "⟲";
  const btnSkip = document.createElement("button");
  btnSkip.className = "pm-skip";
  btnSkip.textContent = "跳过";
  btnSkip.title = "跳过当前阶段";
  controls.append(btnStart, btnReset, btnSkip);

  btnStart.onclick = () => {
    ensureAudio();
    if (data.running) pause();
    else start();
  };
  btnReset.onclick = (ev) => {
    ev.stopPropagation();
    reset();
  };
  btnSkip.onclick = (ev) => {
    ev.stopPropagation();
    skip();
  };

  body.append(tabs, ringWrap, dots, controls);

  const footer = shell.footer;
  footer.classList.add("pm-footer");

  els = {
    root,
    tabs: tabBtns,
    time,
    status,
    dots,
    btnStart,
    btnReset,
    btnSkip,
    footer,
    ring,
    ringLen,
  };

  // 固定（置顶）开关
  const pinBtn = shell.btnPin;
  pinBtn.title = "钉住置顶";
  void getWindowState()
    .then((st) => pinBtn.classList.toggle("active", st.pinned))
    .catch(() => {});
  pinBtn.onclick = () => {
    const next = !pinBtn.classList.contains("active");
    pinBtn.classList.toggle("active", next);
    void setPinned(next).catch(() => pinBtn.classList.toggle("active", !next));
  };

  shell.btnGear.onclick = () => openSettings();

  // 加载持久化状态；若上次运行中且已到点，补齐完成/阶段推进
  void widgetLoad<PomodoroData>("pomodoro", { ...DEFAULT_DATA }).then((d) => {
    data = {
      ...DEFAULT_DATA,
      ...d,
      focusMin: clampNum(d.focusMin, 1, 180, 25),
      shortMin: clampNum(d.shortMin, 1, 60, 5),
      longMin: clampNum(d.longMin, 1, 120, 15),
      longEvery: clampNum(d.longEvery, 2, 8, 4),
      mode: ["focus", "short", "long"].includes(d.mode) ? d.mode : "focus",
      endAt: typeof d.endAt === "number" ? d.endAt : null,
      remaining: Math.max(0, Math.round(Number(d.remaining) || 0)),
      cycle: Math.max(0, Math.round(Number(d.cycle) || 0)),
      todayCount: Math.max(0, Math.round(Number(d.todayCount) || 0)),
    };
    // 跨天清零
    if (data.date !== today()) {
      data.date = today();
      data.todayCount = 0;
    }
    // 运行中恢复：已到点则补齐本次完成，否则按剩余继续走
    if (data.running && data.endAt !== null) {
      const left = Math.max(0, Math.ceil((data.endAt - Date.now()) / 1000));
      if (left <= 0) {
        data.running = false;
        data.endAt = null;
        completePhase();
      } else {
        data.remaining = left;
        data.endAt = Date.now() + left * 1000;
        startTick();
      }
    } else {
      data.running = false;
      data.endAt = null;
      if (data.remaining <= 0) data.remaining = durationOf(data, data.mode);
    }
    persist();
    paint();
  });

  paint();

  return () => {
    stopTick();
    window.clearTimeout(saveTimer);
    els = null;
  };
}

function clampNum(v: unknown, lo: number, hi: number, def: number): number {
  const n = Math.round(Number(v) || NaN);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

registerWidget({
  id: "pomodoro",
  name: "番茄钟",
  icon: "🍅",
  color: "#ff6347",
  desc: "番茄工作法计时：专注与休息自动交替",
  width: 300,
  height: 460,
  minWidth: 240,
  minHeight: 330,
  mount: (root) => mountPomodoro(root),
  summary: async () => {
    const d = await widgetLoad<PomodoroData>("pomodoro", { ...DEFAULT_DATA });
    return d.todayCount > 0 ? `今日已完成 ${d.todayCount} 个番茄` : "今天还没开始专注";
  },
});
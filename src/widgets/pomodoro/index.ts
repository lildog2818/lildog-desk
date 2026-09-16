import { getWindowState, setPinned } from "../../platform/winstate";
import { registerWidget } from "../../platform/registry";
import {
  button,
  closeOverlays,
  field,
  modal,
  promptText,
  textInput,
  toast,
} from "../../platform/shell";
import {
  notifyWidgetData,
  onWidgetDataChanged,
  widgetLoad,
  widgetSave,
} from "../../platform/widget-data";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/pomodoro.css";

type Mode = "focus" | "short" | "long";

/** 单日收成：完成的番茄数与专注秒数 */
interface DayStat {
  count: number;
  focusSec: number;
}

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
  /** 最近 90 天的收成（key: YYYY-MM-DD） */
  history: Record<string, DayStat>;
  /** 累计收成，不受 history 裁剪影响 */
  totalCount: number;
  totalFocusSec: number;
  /** 每周番茄目标（周一为一周起点） */
  weekGoal: number;
  /** 当前选中的备忘录任务 */
  taskId: string | null;
  taskText: string;
  /** 每个任务累计投入的番茄数（taskId -> 颗数） */
  taskSpent: Record<string, number>;
  /** 收获提示音 */
  sound: boolean;
  /** 收获庆祝动画 */
  celebrate: boolean;
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
  history: {},
  totalCount: 0,
  totalFocusSec: 0,
  weekGoal: 20,
  taskId: null,
  taskText: "",
  taskSpent: {},
  sound: true,
  celebrate: true,
};

const MODE_META: Record<
  Mode,
  { label: string; color: string; status: string }
> = {
  focus: { label: "专注", color: "#ff6347", status: "专注中" },
  short: { label: "短休息", color: "#34d399", status: "短休息中" },
  long: { label: "长休息", color: "#60a5fa", status: "长休息中" },
};

/** 青番茄 → 黄 → 熟番茄的果色区间 */
const RIPE_STOPS: Array<[number, [number, number, number]]> = [
  [0, [122, 190, 88]],
  [0.58, [243, 196, 62]],
  [1, [255, 74, 58]],
];

function durationOf(d: PomodoroData, mode: Mode): number {
  const min =
    mode === "focus" ? d.focusMin : mode === "short" ? d.shortMin : d.longMin;
  return Math.max(1, Math.round(min)) * 60;
}

// ---------------- 日期与统计 ----------------

function dayKey(d: Date): string {
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today(): string {
  return dayKey(new Date());
}

/** 相对今天偏移 n 天的日期（取正午，避免夏令时边界问题） */
function dayOffset(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

function statOf(key: string): DayStat {
  return data.history[key] ?? { count: 0, focusSec: 0 };
}

function pruneHistory(): void {
  const cut = dayKey(dayOffset(-89));
  for (const k of Object.keys(data.history)) {
    if (k < cut) delete data.history[k];
  }
}

/** 连续专注天数：今天没收获时从昨天往前算 */
function streakDays(): number {
  let n = 0;
  let i = statOf(today()).count > 0 ? 0 : -1;
  for (; i > -365; i--) {
    if (statOf(dayKey(dayOffset(i))).count > 0) n += 1;
    else break;
  }
  return n;
}

/** 本周（周一起算）完成的番茄数 */
function weekCount(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const from = dayKey(d);
  const to = today();
  let n = 0;
  for (const [k, v] of Object.entries(data.history)) {
    if (k >= from && k <= to) n += v.count;
  }
  return n;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** 紧凑时长：45m / 1h40m */
function fmtShort(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? String(m % 60).padStart(2, "0") : ""}`;
}

function ripenColor(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < RIPE_STOPS.length - 2 && k > RIPE_STOPS[i + 1][0]) i += 1;
  const [k0, c0] = RIPE_STOPS[i];
  const [k1, c1] = RIPE_STOPS[i + 1];
  const f = k1 === k0 ? 0 : (k - k0) / (k1 - k0);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * f);
  return `rgb(${mix(c0[0], c1[0])}, ${mix(c0[1], c1[1])}, ${mix(
    c0[2],
    c1[2],
  )})`;
}

// ---------------- 状态 ----------------

let data: PomodoroData = { ...DEFAULT_DATA };
let saveTimer = 0;
/** 收获后清除：让田地里的最后一颗番茄播放落入动画 */
let freshCrop = false;
/** 上一次写入的成熟档位（1/24 一档），避免每秒重写 CSS 变量 */
let lastRipenStep = -1;

function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("pomodoro", structuredClone(data));
  }, 250);
}

/** 跨天：重置当日计数 */
function rollDay(): void {
  const t = today();
  if (data.date !== t) {
    data.date = t;
    data.todayCount = 0;
  }
}

// ---------------- 计时 ----------------

/** 轻量计时器：基于截止时刻重算剩余，Webview 被节流时仍然准确 */
let tickTimer = 0;

function renderTick(): void {
  if (!data.running || data.endAt === null) return;
  const left = Math.max(0, Math.ceil((data.endAt - Date.now()) / 1000));
  const changed = left !== data.remaining;
  data.remaining = left;
  if (changed) {
    paintRemaining();
    paintScene();
  }
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

/** 进行中的这一颗番茄在本轮里是第几颗 */
function focusIndexOfRun(): number {
  return (data.cycle % Math.max(1, data.longEvery)) + 1;
}

/** 休息时展示：刚刚完成的是本轮第几颗 */
function doneInRun(): number {
  return ((data.cycle - 1) % Math.max(1, data.longEvery)) + 1;
}

/** 一个阶段自然结束：专注结束收获并进入休息；休息结束回到专注。均暂停待开始 */
function completePhase(): void {
  const finished = data.mode;
  if (finished === "focus") {
    const mins = Math.max(1, Math.round(data.focusMin));
    data.cycle += 1;
    rollDay();
    data.todayCount += 1;
    data.totalCount += 1;
    data.totalFocusSec += mins * 60;
    const key = today();
    const cur = statOf(key);
    data.history[key] = {
      count: cur.count + 1,
      focusSec: cur.focusSec + mins * 60,
    };
    pruneHistory();
    if (data.taskId) {
      data.taskSpent[data.taskId] = (data.taskSpent[data.taskId] ?? 0) + 1;
    }
    freshCrop = true;
  }
  const next = nextMode(finished);
  data.mode = next;
  data.running = false;
  data.endAt = null;
  data.remaining = durationOf(data, next);
  persist();
  const mins = Math.round(data.remaining / 60);
  if (finished === "focus") {
    const long = next === "long";
    toast(
      long
        ? `🍅 一串番茄到手！长休息 ${mins} 分钟`
        : `🍅 第 ${data.todayCount} 颗番茄收获，休息 ${mins} 分钟`,
    );
    cheer();
    chime("harvest");
  } else {
    toast(`☕ 休息结束，开始第 ${focusIndexOfRun()} 颗番茄`);
    chime("go");
  }
}

// ---------------- 收获庆祝 ----------------

const BITS = ["🍅", "🍅", "✨", "🍃", "✨", "🍅"];

/** 收成瞬间：番茄粒子从角色身上炸开，角色蹦一下 */
function cheer(): void {
  if (!els || !data.celebrate) return;
  const stage = els.stage;
  for (let i = 0; i < 14; i++) {
    const bit = document.createElement("i");
    bit.className = "pm-bit";
    const angle = Math.random() * Math.PI * 2;
    const dist = 42 + Math.random() * 76;
    bit.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    bit.style.setProperty("--dy", `${Math.sin(angle) * dist - 26}px`);
    bit.style.setProperty("--rz", `${Math.round(Math.random() * 620 - 310)}deg`);
    bit.style.setProperty("--t", `${(0.72 + Math.random() * 0.6).toFixed(2)}s`);
    bit.textContent = BITS[i % BITS.length];
    stage.appendChild(bit);
    window.setTimeout(() => bit.remove(), 1500);
  }
  stage.classList.remove("cheer");
  void stage.offsetWidth;
  stage.classList.add("cheer");
  window.setTimeout(() => stage.classList.remove("cheer"), 900);
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

/** harvest=收获的三连上行音；go=回到专注的两声轻提示 */
function chime(kind: "harvest" | "go"): void {
  ensureAudio();
  if (!audioCtx || !data.sound) return;
  const ctx = audioCtx;
  void ctx.resume().catch(() => {});
  const notes = kind === "harvest" ? [659.25, 830.61, 987.77] : [587.33, 440];
  const now = ctx.currentTime;
  notes.forEach((freq, i) => {
    const t = now + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "harvest" ? "triangle" : "sine";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === "harvest" ? 0.2 : 0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.46);
  });
}

// ---------------- 备忘录联动 ----------------

interface MemoItem {
  id: string;
  text: string;
  done: boolean;
}

interface MemoData {
  items: MemoItem[];
}

function validItems(d: MemoData): MemoItem[] {
  return Array.isArray(d.items)
    ? d.items.filter(
        (i): i is MemoItem =>
          typeof i?.id === "string" &&
          typeof i?.text === "string" &&
          typeof i?.done === "boolean",
      )
    : [];
}

async function loadMemo(): Promise<MemoItem[]> {
  try {
    const d = await widgetLoad<MemoData>("memo", { items: [] });
    return validItems(d);
  } catch {
    return [];
  }
}

/** 在备忘录里勾掉某条任务 */
async function completeMemoTask(id: string): Promise<boolean> {
  try {
    const d = await widgetLoad<MemoData>("memo", { items: [] });
    const items = validItems(d);
    const hit = items.find((i) => i.id === id);
    if (!hit) return false;
    hit.done = true;
    await widgetSave("memo", { items });
    notifyWidgetData("memo");
    return true;
  } catch {
    return false;
  }
}

/** 直接在备忘录里新建一条任务 */
async function createMemoTask(text: string): Promise<MemoItem | null> {
  try {
    const d = await widgetLoad<MemoData>("memo", { items: [] });
    const items = validItems(d);
    const item: MemoItem = { id: crypto.randomUUID(), text, done: false };
    items.unshift(item);
    await widgetSave("memo", { items });
    notifyWidgetData("memo");
    return item;
  } catch {
    return null;
  }
}

function pickTask(item: MemoItem | null): void {
  data.taskId = item ? item.id : null;
  data.taskText = item ? item.text : "";
  persist();
  paintTask();
  closeOverlays();
  toast(item ? `这颗番茄交给「${item.text}」` : "已取消任务标签");
}

/** 备忘录被其它窗口改动：任务被勾掉或删除后自动摘掉番茄钟上的标签 */
function refreshTaskLink(): void {
  const id = data.taskId;
  if (!id) return;
  void loadMemo().then((items) => {
    if (data.taskId !== id) return;
    const hit = items.find((i) => i.id === id);
    if (hit && !hit.done) return;
    data.taskId = null;
    data.taskText = "";
    persist();
    paintTask();
  });
}

// ---------------- 渲染 ----------------

interface PomodoroEls {
  root: HTMLElement;
  tabs: Record<Mode, HTMLButtonElement>;
  stage: HTMLDivElement;
  ringbox: HTMLDivElement;
  time: HTMLDivElement;
  /** 时间文字本身（用于量真实文本尺寸） */
  timeInner: HTMLSpanElement;
  status: HTMLDivElement;
  /** 状态文字本身（外层是撑满圆环的定位层） */
  statusInner: HTMLSpanElement;
  ring: SVGCircleElement;
  ringLen: number;
  crops: HTMLSpanElement;
  fieldMeta: HTMLSpanElement;
  task: HTMLDivElement;
  taskMain: HTMLButtonElement;
  taskIcon: HTMLSpanElement;
  taskLabel: HTMLSpanElement;
  taskCount: HTMLSpanElement;
  taskDone: HTMLButtonElement;
  btnStart: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnSkip: HTMLButtonElement;
}

let els: PomodoroEls | null = null;

/** 场景只保留圆环本身：中间放大号倒计时，状态行放在圆环下方 */
const SCENE_SVG = `
  <circle class="pm-ring-bg" cx="100" cy="100" r="88" />
  <circle class="pm-ring-fg" cx="100" cy="100" r="88" />`;

/** 收获/庆祝时给圆环加一个脉冲状态（角色已移除，用圆环本身表达） */
function setSceneState(): void {
  if (!els) return;
  const total = durationOf(data, data.mode);
  let state: string;
  if (data.mode !== "focus") state = "rest";
  else if (data.running) state = data.remaining <= 60 ? "ripe" : "focus";
  else if (data.remaining < total) state = "pause";
  else state = "idle";
  els.root.dataset.state = state;
}

/** 果实成熟度仅用于圆环配色：越接近完成越红，休息时是休息色 */
function paintScene(): void {
  if (!els) return;
  setSceneState();
  const total = durationOf(data, data.mode);
  const grown =
    data.mode === "focus"
      ? Math.max(0, Math.min(1, 1 - data.remaining / total))
      : 1;
  const step = Math.round(grown * 24) / 24;
  if (step === lastRipenStep) return;
  lastRipenStep = step;
  els.root.style.setProperty("--pm-ripe", ripenColor(step));
}

function paintRemaining(): void {
  if (!els) return;
  const total = durationOf(data, data.mode);
  const frac = Math.max(0, Math.min(1, data.remaining / total));
  els.ring.style.strokeDashoffset = String(els.ringLen * (1 - frac));
  els.timeInner.textContent = fmtTime(data.remaining);
}

/** 圆环尺寸随可用空间缩放；数字字号再由 settleLayout 实测收敛 */
function fitStage(): void {
  if (!els) return;
  const e = els;
  const w = e.stage.clientWidth;
  const h = e.stage.clientHeight;
  // 状态行是圆环下方独立一行，先给它留出高度，剩下的才是圆环可用空间
  const statusH = e.status.offsetHeight || 16;
  const availW = Math.max(60, w);
  const availH = Math.max(50, h - statusH - 8);
  const size = Math.max(56, Math.min(availW, availH, 260));
  e.ringbox.style.width = `${size}px`;
  e.ringbox.style.height = `${size}px`;
  e.root.style.setProperty("--pm-fit", (size / 200).toFixed(3));
  // 状态行单独一档缩放：只随窗口小幅变化，且设上限，避免长得比正文还大
  e.root.style.setProperty(
    "--pm-status-fit",
    Math.min(1.15, Math.max(0.85, size / 210)).toFixed(3),
  );
  // 视口偏矮时逐级收紧纵向排布（标题/圆环/任务/按钮/田地各让一点空间）
  const vh = window.innerHeight;
  e.root.classList.toggle("pm-tight", vh < 440);
  e.root.classList.toggle("pm-tighter", vh < 390);
  settleLayout();
}

/**
 * 实测收敛：数字必须装进圆环内（状态行已在圆环下方，不再参与重叠判定）。
 * 字号对应的实际文本宽度受字体、字距影响，公式只能粗估，所以渲染后量真值双向逼近。
 */
function settleLayout(): void {
  if (!els) return;
  const e = els;
  let fit = parseFloat(e.root.style.getPropertyValue("--pm-fit"));
  if (!Number.isFinite(fit) || fit <= 0) fit = 1;
  const MIN = 0.5;
  const MAX = 2;

  const tooBig = (): boolean => {
    const t = e.timeInner.getBoundingClientRect();
    const box = e.ringbox.getBoundingClientRect();
    const stage = e.stage.getBoundingClientRect();
    if (t.width === 0 || box.width === 0) return false;
    // 圆环笔画内沿：viewBox 200 中 stroke-width 7，内缩 3.5 → 1.75%
    const innerD = box.width * (1 - 7 / 100);
    return (
      t.width > innerD - 14 || // 左右贴到圈上（留出内边距）
      t.height > innerD - 14 || // 上下贴到圈上
      t.top < stage.top - 0.5 || // 溢出场景框
      t.bottom > stage.bottom + 0.5
    );
  };
  const tooSmall = (): boolean => {
    const box = e.ringbox.getBoundingClientRect();
    const t = e.timeInner.getBoundingClientRect();
    // 数字宽度理想值约为圆环内径的 62%（太小显得空，太大贴圈）
    return box.width > 0 && t.width < box.width * 0.6;
  };

  for (let i = 0; i < 20; i++) {
    if (tooBig()) {
      const next = fit - 0.05;
      if (next < MIN) break;
      fit = next;
    } else if (tooSmall() && fit < MAX) {
      fit = Math.min(MAX, fit + 0.05);
    } else {
      break; // 落在容差区间内
    }
    e.root.style.setProperty("--pm-fit", fit.toFixed(3));
  }
}

function paintStatus(): void {
  if (!els) return;
  const meta = MODE_META[data.mode];
  const total = durationOf(data, data.mode);
  const text = data.running
    ? data.mode === "focus"
      ? `专注中 · 第 ${focusIndexOfRun()}/${data.longEvery} 颗`
      : `${meta.status} · 本轮 ${doneInRun()}/${data.longEvery}`
    : data.remaining < total
      ? `已暂停 · 点继续回到「${meta.label}」`
      : data.mode === "focus"
        ? `点开始，种下第 ${focusIndexOfRun()} 颗`
        : `点开始，${meta.label}一下`;
  els.statusInner.textContent = text;
  els.status.title = text;
}

/** 底部田地：今日收获的番茄 + 连续天数 */
function paintField(): void {
  if (!els) return;
  const e = els;
  const total = data.todayCount;
  const MAX = 9;
  e.crops.innerHTML = "";
  const shown = Math.min(total, MAX);
  for (let i = 0; i < shown; i++) {
    const crop = document.createElement("span");
    crop.className =
      freshCrop && i === shown - 1 ? "pm-crop new" : "pm-crop";
    crop.textContent = "🍅";
    e.crops.appendChild(crop);
  }
  if (total > MAX) {
    const more = document.createElement("span");
    more.className = "pm-crop-more";
    more.textContent = `+${total - MAX}`;
    e.crops.appendChild(more);
  }
  if (data.running && data.mode === "focus") {
    const sprout = document.createElement("span");
    sprout.className = "pm-crop sprout";
    sprout.textContent = "🌱";
    e.crops.appendChild(sprout);
  }
  if (total === 0 && !(data.running && data.mode === "focus")) {
    const hint = document.createElement("span");
    hint.className = "pm-field-hint";
    hint.textContent = "还没开张 · 第一颗番茄在等你";
    e.crops.appendChild(hint);
  }
  const streak = streakDays();
  e.fieldMeta.textContent =
    total > 0 || streak > 0
      ? `今日 ${total} 颗${streak > 1 ? ` · 🔥 ${streak} 天` : ""}`
      : "今日 0 颗";
  freshCrop = false;
}

function paintTask(): void {
  if (!els) return;
  const e = els;
  const linked = Boolean(data.taskId && data.taskText);
  e.task.classList.toggle("linked", linked);
  e.taskIcon.textContent = linked ? "📌" : "＋";
  e.taskLabel.textContent = linked ? data.taskText : "选一颗番茄要做什么";
  const spent = linked && data.taskId ? data.taskSpent[data.taskId] ?? 0 : 0;
  e.taskCount.textContent = spent > 0 ? `×${spent}` : "";
  e.taskDone.classList.toggle("hidden", !linked);
  e.taskDone.classList.toggle("hint", linked && spent > 0);
  e.taskMain.title = linked ? "点击更换任务（来自备忘录）" : "从备忘录里选一个未完成任务";
}

function paintControls(): void {
  if (!els) return;
  els.btnStart.textContent = data.running
    ? "暂停"
    : data.remaining > 0 && data.remaining < durationOf(data, data.mode)
      ? "继续"
      : "开始";
  els.btnStart.classList.toggle("running", data.running);
}

function paint(): void {
  if (!els) return;
  els.root.style.setProperty("--pm-c", MODE_META[data.mode].color);
  for (const m of ["focus", "short", "long"] as const) {
    els.tabs[m].classList.toggle("on", m === data.mode);
  }
  paintScene();
  paintRemaining();
  paintStatus();
  paintField();
  paintTask();
  paintControls();
  // 文字内容变化（如状态文案变长）后重新收敛一次
  settleLayout();
}

// ---------------- 任务选择（来自备忘录） ----------------

function openTaskPicker(): void {
  closeOverlays();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const sheet = document.createElement("div");
  sheet.className = "pm-sheet";

  const head = document.createElement("div");
  head.className = "pm-sheet-head";
  const title = document.createElement("span");
  title.textContent = "这颗番茄做什么？";
  const close = document.createElement("button");
  close.className = "pm-x";
  close.textContent = "✕";
  close.title = "关闭";
  close.onclick = () => closeOverlays();
  head.append(title, close);

  const note = document.createElement("div");
  note.className = "pm-note";
  note.textContent = "列表来自备忘录里未完成的待办";

  const quickRow = document.createElement("div");
  quickRow.className = "pm-quick";
  const quick = textInput("");
  quick.placeholder = "新建任务并选中（回车）";
  const quickAdd = document.createElement("button");
  quickAdd.className = "pm-quick-add";
  quickAdd.textContent = "＋";
  quickRow.append(quick, quickAdd);

  const list = document.createElement("div");
  list.className = "pm-task-list";

  const none = document.createElement("button");
  none.className = "pm-task-row none";
  none.textContent = "暂不指定任务";
  none.onclick = () => pickTask(null);

  sheet.append(head, note, quickRow, list, none);
  overlay.appendChild(sheet);
  overlay.onpointerdown = (ev) => {
    if (ev.target === overlay) closeOverlays();
  };
  document.body.appendChild(overlay);

  const submitQuick = (): void => {
    const text = quick.value.trim();
    if (!text) return;
    void createMemoTask(text).then((item) => {
      if (!item) {
        toast("写入备忘录失败");
        return;
      }
      pickTask(item);
    });
  };
  quickAdd.onclick = submitQuick;
  quick.onkeydown = (ev) => {
    if (ev.key === "Enter") submitQuick();
  };

  void loadMemo().then((items) => {
    const pending = items.filter((i) => !i.done);
    if (pending.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-empty";
      empty.textContent = "备忘录里没有未完成的待办，上面可直接新建一条";
      list.appendChild(empty);
    }
    for (const item of pending) {
      const row = document.createElement("button");
      row.className = "pm-task-row" + (item.id === data.taskId ? " on" : "");
      const text = document.createElement("span");
      text.className = "pm-task-row-text";
      text.textContent = item.text;
      row.appendChild(text);
      const spent = data.taskSpent[item.id] ?? 0;
      if (spent > 0) {
        const badge = document.createElement("span");
        badge.className = "pm-task-row-n";
        badge.textContent = `×${spent}`;
        row.appendChild(badge);
      }
      row.onclick = () => pickTask(item);
      list.appendChild(row);
    }
    quick.focus();
  });
}

// ---------------- 专注数据面板 ----------------

function openStats(): void {
  closeOverlays();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const sheet = document.createElement("div");
  sheet.className = "pm-sheet";

  const head = document.createElement("div");
  head.className = "pm-sheet-head";
  const title = document.createElement("span");
  title.textContent = "专注数据";
  const close = document.createElement("button");
  close.className = "pm-x";
  close.textContent = "✕";
  close.title = "关闭";
  close.onclick = () => closeOverlays();
  head.append(title, close);

  const todayStat = statOf(today());
  const kpis = document.createElement("div");
  kpis.className = "pm-kpis";
  const kpiData: Array<[string, string]> = [
    [String(todayStat.count), "今日番茄"],
    [fmtShort(todayStat.focusSec), "今日专注"],
    [String(streakDays()), "连续天数"],
  ];
  for (const [value, label] of kpiData) {
    const box = document.createElement("div");
    box.className = "pm-kpi";
    const b = document.createElement("b");
    b.textContent = value;
    const s = document.createElement("span");
    s.textContent = label;
    box.append(b, s);
    kpis.appendChild(box);
  }

  const week = weekCount();
  const goal = Math.max(1, Math.round(data.weekGoal));
  const goalBox = document.createElement("div");
  goalBox.className = "pm-goal";
  const goalHead = document.createElement("div");
  goalHead.className = "pm-goal-head";
  const goalTitle = document.createElement("span");
  goalTitle.textContent = "本周目标";
  const goalVal = document.createElement("span");
  goalVal.className = "pm-goal-val";
  goalVal.textContent = `${week} / ${goal} 颗`;
  goalHead.append(goalTitle, goalVal);
  const bar = document.createElement("div");
  bar.className = "pm-bar";
  const fill = document.createElement("i");
  fill.style.width = `${Math.min(100, (week / goal) * 100)}%`;
  bar.appendChild(fill);
  const goalBtn = document.createElement("button");
  goalBtn.className = "pm-mini";
  goalBtn.textContent = "调整每周目标";
  goalBtn.onclick = () =>
    promptText("每周番茄目标（颗）", String(goal), (v) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1) {
        toast("请输入 1 以上的数字");
        return;
      }
      data.weekGoal = Math.min(200, n);
      persist();
      // promptText 提交后会统一关闭浮层，延后一帧重开数据面板
      window.setTimeout(() => openStats(), 0);
    });
  goalBox.append(goalHead, bar, goalBtn);

  // 最近 7 天
  const chart = document.createElement("div");
  chart.className = "pm-chart";
  const days = Array.from({ length: 7 }, (_, i) => dayOffset(i - 6));
  const counts = days.map((d) => statOf(dayKey(d)).count);
  const max = Math.max(1, ...counts);
  const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "pm-col" + (i === 6 ? " today" : "");
    const num = document.createElement("span");
    num.className = "pm-col-num";
    num.textContent = counts[i] > 0 ? String(counts[i]) : "";
    const track = document.createElement("div");
    track.className = "pm-col-track";
    const barEl = document.createElement("i");
    barEl.style.height = `${counts[i] > 0 ? Math.max(8, (counts[i] / max) * 100) : 4}%`;
    if (counts[i] === 0) barEl.classList.add("zero");
    track.appendChild(barEl);
    const lab = document.createElement("span");
    lab.className = "pm-col-lab";
    lab.textContent = i === 6 ? "今" : weekNames[d.getDay()];
    col.append(num, track, lab);
    chart.appendChild(col);
  });

  const total = document.createElement("div");
  total.className = "pm-total";
  total.textContent = `累计 ${data.totalCount} 颗 · ${fmtShort(data.totalFocusSec)} 专注`;

  sheet.append(head, kpis, goalBox, chart, total);
  overlay.appendChild(sheet);
  overlay.onpointerdown = (ev) => {
    if (ev.target === overlay) closeOverlays();
  };
  document.body.appendChild(overlay);
}

// ---------------- 设置 ----------------

function checkRow(text: string, value: boolean): {
  el: HTMLDivElement;
  input: HTMLInputElement;
} {
  const el = document.createElement("div");
  el.className = "pm-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  const label = document.createElement("span");
  label.textContent = text;
  el.append(input, label);
  return { el, input };
}

function openSettings(): void {
  const num = (value: number, min: number, max: number): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    return input;
  };
  const focusMin = num(data.focusMin, 1, 180);
  const shortMin = num(data.shortMin, 1, 60);
  const longMin = num(data.longMin, 1, 120);
  const longEvery = num(data.longEvery, 2, 8);
  const weekGoal = num(data.weekGoal, 1, 200);
  const sound = checkRow("收获提示音", data.sound);
  const celebrate = checkRow("收获庆祝动画", data.celebrate);

  const clamp = (input: HTMLInputElement, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.round(Number(input.value) || lo)));

  modal(
    "番茄钟设置",
    [
      field("专注时长（分钟）", focusMin),
      field("短休息（分钟）", shortMin),
      field("长休息（分钟）", longMin),
      field("每几个专注后长休息", longEvery),
      field("每周番茄目标（颗）", weekGoal),
      sound.el,
      celebrate.el,
    ],
    [
      button("取消", "", () => closeOverlays()),
      button("保存", "primary", () => {
        const running = data.running;
        data.focusMin = clamp(focusMin, 1, 180);
        data.shortMin = clamp(shortMin, 1, 60);
        data.longMin = clamp(longMin, 1, 120);
        data.longEvery = clamp(longEvery, 2, 8);
        data.weekGoal = clamp(weekGoal, 1, 200);
        data.sound = sound.input.checked;
        data.celebrate = celebrate.input.checked;
        if (running) pause();
        data.remaining = durationOf(data, data.mode);
        persist();
        paint();
      }),
    ],
  );
}

// ---------------- 挂载 ----------------

function mountPomodoro(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "🍅", "番茄钟");
  root.classList.add("pm-root");
  lastRipenStep = -1;
  // 刷新按钮改造为「专注数据」入口
  const btnStats = shell.btnRefresh;
  btnStats.textContent = "📊";
  btnStats.title = "专注数据";
  btnStats.onclick = () => openStats();

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

  // 场景：圆环 + 居中的大号倒计时（圆环下方是状态行，不再放角色）
  const stage = document.createElement("div");
  stage.className = "pm-stage";
  const ringbox = document.createElement("div");
  ringbox.className = "pm-ringbox";
  const R = 88;
  const ringLen = 2 * Math.PI * R;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "pm-scene");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.innerHTML = SCENE_SVG;
  const ring = svg.querySelector<SVGCircleElement>(".pm-ring-fg")!;
  ring.style.strokeDasharray = String(ringLen);
  // 数字居中在圆环内；内层 span 才有"文字本身"的尺寸，外层是撑满圆环的定位层
  const time = document.createElement("div");
  time.className = "pm-time";
  const timeInner = document.createElement("span");
  time.appendChild(timeInner);
  ringbox.append(svg, time);

  // 状态行放在圆环下方（独立一行，不再与圆环/数字争位置）
  const status = document.createElement("div");
  status.className = "pm-status";
  const statusInner = document.createElement("span");
  status.appendChild(statusInner);

  stage.append(ringbox, status);

  // 任务标签（联动备忘录）
  const task = document.createElement("div");
  task.className = "pm-task";
  const taskMain = document.createElement("button");
  taskMain.className = "pm-task-main";
  const taskIcon = document.createElement("span");
  taskIcon.className = "pm-task-ico";
  const taskLabel = document.createElement("span");
  taskLabel.className = "pm-task-label";
  const taskCount = document.createElement("span");
  taskCount.className = "pm-task-n";
  taskMain.append(taskIcon, taskLabel, taskCount);
  const taskDone = document.createElement("button");
  taskDone.className = "pm-task-done hidden";
  taskDone.textContent = "✓";
  taskDone.title = "在备忘录里标记为已完成";
  task.append(taskMain, taskDone);

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

  body.append(tabs, stage, task, controls);

  // 底部田地
  const footer = shell.footer;
  footer.classList.add("pm-field");
  const crops = document.createElement("span");
  crops.className = "pm-crops";
  const fieldMeta = document.createElement("span");
  fieldMeta.className = "pm-field-meta";
  footer.append(crops, fieldMeta);

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
  taskMain.onclick = () => openTaskPicker();
  taskDone.onclick = (ev) => {
    ev.stopPropagation();
    const id = data.taskId;
    if (!id) return;
    void completeMemoTask(id).then((ok) => {
      if (!ok) {
        toast("这条任务已不在备忘录里");
      } else {
        toast(`✓ 已完成「${data.taskText}」`);
      }
      data.taskId = null;
      data.taskText = "";
      persist();
      paintTask();
    });
  };

  els = {
    root,
    tabs: tabBtns,
    stage,
    ringbox,
    time,
    timeInner,
    status,
    statusInner,
    ring,
    ringLen,
    crops,
    fieldMeta,
    task,
    taskMain,
    taskIcon,
    taskLabel,
    taskCount,
    taskDone,
    btnStart,
    btnReset,
    btnSkip,
  };

  // 窗口尺寸变化时重新排布（含文字缩放收敛）
  const observer = new ResizeObserver(() => {
    fitStage();
    window.requestAnimationFrame(() => settleLayout());
  });
  observer.observe(stage);
  fitStage();
  window.requestAnimationFrame(() => settleLayout());

  // 备忘录里的任务被勾掉/删除时，摘掉当前任务标签
  const stopMemoWatch = onWidgetDataChanged("memo", refreshTaskLink);

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
      weekGoal: clampNum(d.weekGoal, 1, 200, 20),
      mode: ["focus", "short", "long"].includes(d.mode) ? d.mode : "focus",
      endAt: typeof d.endAt === "number" ? d.endAt : null,
      remaining: Math.max(0, Math.round(Number(d.remaining) || 0)),
      cycle: Math.max(0, Math.round(Number(d.cycle) || 0)),
      todayCount: Math.max(0, Math.round(Number(d.todayCount) || 0)),
      sound: d.sound !== false,
      celebrate: d.celebrate !== false,
      taskId: typeof d.taskId === "string" ? d.taskId : null,
      taskText: typeof d.taskText === "string" ? d.taskText : "",
      taskSpent: isCountMap(d.taskSpent) ? d.taskSpent : {},
      history: isHistory(d.history) ? d.history : {},
      totalCount: Math.max(0, Math.round(Number(d.totalCount) || 0)),
      totalFocusSec: Math.max(0, Math.round(Number(d.totalFocusSec) || 0)),
    };
    // 跨天清零
    if (data.date !== today()) {
      data.date = today();
      data.todayCount = 0;
    }
    // 老数据没有 history：用今日计数补齐一条，累计值也一并补上
    const key = today();
    if (!data.history[key] && data.todayCount > 0) {
      data.history[key] = {
        count: data.todayCount,
        focusSec: data.todayCount * data.focusMin * 60,
      };
    }
    if (data.totalCount === 0 && data.todayCount > 0) {
      data.totalCount = data.todayCount;
      data.totalFocusSec = data.todayCount * data.focusMin * 60;
    }
    pruneHistory();
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
    observer.disconnect();
    stopMemoWatch();
    stopTick();
    window.clearTimeout(saveTimer);
    els = null;
  };
}

function isCountMap(v: unknown): v is Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (n) => typeof n === "number",
  );
}

function isHistory(v: unknown): v is Record<string, DayStat> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((s) => {
    if (typeof s !== "object" || s === null) return false;
    const row = s as Record<string, unknown>;
    return typeof row.count === "number" && typeof row.focusSec === "number";
  });
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
  desc: "番茄工作法计时：小番茄随专注长大，收获后进入休息",
  width: 320,
  height: 520,
  minWidth: 250,
  minHeight: 340,
  mount: (root) => mountPomodoro(root),
  summary: async () => {
    const d = await widgetLoad<PomodoroData>("pomodoro", { ...DEFAULT_DATA });
    if (d.todayCount > 0) {
      return `今日收获 ${d.todayCount} 颗番茄`;
    }
    return "今天还没开始专注";
  },
});

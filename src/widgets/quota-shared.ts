import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { widgetLoad, widgetSave } from "../platform/widget-data";
import { getWindowState, setPinned } from "../platform/winstate";
import "./../styles/quota.css";

export interface QuotaConfig {
  apiKey: string;
  intervalMin: number;
}

export const DEFAULT_INTERVAL = 5;

export async function loadQuotaConfig<T extends QuotaConfig>(
  widgetId: string,
  defaults: T,
): Promise<T> {
  const d = await widgetLoad<Partial<T>>(widgetId, {});
  return {
    ...defaults,
    ...d,
    apiKey: typeof d.apiKey === "string" ? d.apiKey : "",
    intervalMin:
      typeof d.intervalMin === "number" && d.intervalMin >= 1
        ? d.intervalMin
        : DEFAULT_INTERVAL,
  };
}

const timers = new Map<string, number>();

export function persistQuota(widgetId: string, data: unknown): void {
  void widgetSave(widgetId, data);
}

export function schedulePoll(
  widgetId: string,
  fn: () => void,
): () => void {
  stopPoll(widgetId);
  const h = window.setInterval(fn, 60_000);
  timers.set(widgetId, h);
  return () => stopPoll(widgetId);
}

function stopPoll(widgetId: string): void {
  const h = timers.get(widgetId);
  if (h !== undefined) {
    window.clearInterval(h);
    timers.delete(widgetId);
  }
}

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export function usageColor(percentUsed: number): string {
  if (percentUsed >= 80) return "#ff6b6b";
  if (percentUsed >= 50) return "#ffd166";
  return "#6ee7b7";
}

export function countdownText(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "已重置";
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}天${h % 24}时后重置`;
  if (h > 0) return `${h}时${m % 60}分后重置`;
  return `${m}分后重置`;
}

export async function fetchJson(url: string, token: string): Promise<unknown> {
  return invoke<unknown>("fetch_json", { url, token });
}

export interface BarRow {
  root: HTMLDivElement;
  setUsage(win: UsageWindow | null, label?: string): void;
}

export function buildBarRow(title: string): BarRow {
  const root = document.createElement("div");
  root.className = "qbar";

  const head = document.createElement("div");
  head.className = "qbar-head";
  const name = document.createElement("span");
  name.className = "qbar-name";
  name.textContent = title;
  const val = document.createElement("span");
  val.className = "qbar-val";
  val.textContent = "--";
  head.append(name, val);

  const track = document.createElement("div");
  track.className = "qbar-track";
  const fill = document.createElement("div");
  fill.className = "qbar-fill";
  fill.style.width = "0%";
  track.appendChild(fill);

  const foot = document.createElement("div");
  foot.className = "qbar-foot";

  root.append(head, track, foot);

  return {
    root,
    setUsage(win, label) {
      if (!win || !Number.isFinite(win.percent)) {
        val.textContent = "--";
        fill.style.width = "0%";
        fill.style.background = "rgba(255,255,255,0.25)";
        foot.textContent = "";
        if (label) val.textContent = label;
        return;
      }
      const p = Math.max(0, Math.min(100, Math.round(win.percent)));
      val.textContent = `${p}%`;
      fill.style.width = `${p}%`;
      fill.style.background = usageColor(p);
      foot.textContent = countdownText(win.resetsAt);
    },
  };
}

export function buildWidgetShell(
  root: HTMLElement,
  icon: string,
  title: string,
): {
  body: HTMLDivElement;
  footer: HTMLDivElement;
  btnRefresh: HTMLButtonElement;
  btnGear: HTMLButtonElement;
  btnPin: HTMLButtonElement;
  header: HTMLElement;
} {
  root.innerHTML = `
    <header id="header">
      <span class="qw-icon">${icon}</span>
      <span class="qw-title">${title}</span>
      <span style="flex:1"></span>
    </header>
    <main id="board" class="qw-body"></main>
    <div class="qw-footer"></div>
  `;
  const header = root.querySelector<HTMLElement>("#header")!;
  const body = root.querySelector<HTMLDivElement>(".qw-body")!;
  const footer = root.querySelector<HTMLDivElement>(".qw-footer")!;

  const btnRefresh = document.createElement("button");
  btnRefresh.className = "icon-btn";
  btnRefresh.title = "立即刷新";
  btnRefresh.textContent = "⟳";
  const btnGear = document.createElement("button");
  btnGear.className = "icon-btn";
  btnGear.title = "设置";
  btnGear.textContent = "⚙";
  // 固定（置顶）开关，与快捷启动组件一致
  const btnPin = document.createElement("button");
  btnPin.className = "icon-btn";
  btnPin.title = "钉住置顶";
  btnPin.textContent = "📌";
  void getWindowState()
    .then((st) => btnPin.classList.toggle("active", st.pinned))
    .catch(() => {});
  btnPin.onclick = () => {
    const next = !btnPin.classList.contains("active");
    btnPin.classList.toggle("active", next);
    void setPinned(next).catch(() => btnPin.classList.toggle("active", !next));
  };
  header.append(btnRefresh, btnGear, btnPin);

  header.addEventListener("pointerdown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button")) return;
    void getCurrentWindow().startDragging();
  });

  return { body, footer, btnRefresh, btnGear, btnPin, header };
}

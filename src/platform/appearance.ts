import { getCurrentWebview } from "@tauri-apps/api/webview";
import { applyPanelAlpha, installResizePulse, toast } from "./shell";
import {
  getAutostart,
  getWindowState,
  setAutostart,
  setBgOpacity,
  setSizeStep,
} from "./winstate";

/** 每个窗口启动时调用一次：应用全局透明度并监听变更广播 */
export function initAppearance(): void {
  installResizePulse();
  try {
    void getWindowState().then((st) => applyPanelAlpha(st.bgOpacity));
  } catch {
    applyPanelAlpha(0.55);
  }
  void getCurrentWebview()
    .listen<number>("bg-opacity", (ev) => applyPanelAlpha(ev.payload))
    .catch(() => {});
}

interface SliderSpec {
  label: string;
  initial: number;
  min: number;
  max: number;
  stepSize: number;
  format?: (v: number) => string;
  onLive?: (v: number) => void;
  onCommit: (v: number) => Promise<void> | void;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function sliderRow(spec: SliderSpec): HTMLDivElement {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "opacity-head";
  const title = document.createElement("span");
  title.textContent = spec.label;
  const val = document.createElement("span");
  val.className = "opacity-val";
  const fmt = spec.format ?? ((v: number) => `${Math.round(v * 100)}%`);
  val.textContent = fmt(spec.initial);
  head.append(title, val);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "opacity-slider";
  slider.min = String(spec.min);
  slider.max = String(spec.max);
  slider.step = String(spec.stepSize);
  slider.value = String(spec.initial);

  let timer = 0;
  let current = spec.initial;
  slider.oninput = () => {
    current = parseFloat(slider.value);
    val.textContent = fmt(current);
    spec.onLive?.(current);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void Promise.resolve(spec.onCommit(current)).catch((e) =>
        toast(String(e)),
      );
    }, 220);
  };

  wrap.appendChild(head);
  wrap.appendChild(slider);
  return wrap;
}

/** 阶梯档位选择：离散的大步进值，调节大小时产生明显的分级放大效果 */
function stepLadderRow(initial: number): HTMLDivElement {
  const options = [32, 48, 64, 80, 96];
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "opacity-head";
  const title = document.createElement("span");
  title.textContent = "窗口步进";
  const val = document.createElement("span");
  val.className = "opacity-val";
  const nearest = options.reduce((a, b) =>
    Math.abs(b - initial) < Math.abs(a - initial) ? b : a,
  );
  val.textContent = `${nearest}px`;
  head.append(title, val);

  const row = document.createElement("div");
  row.className = "ladder-row";
  for (const opt of options) {
    const b = document.createElement("button");
    b.className = "ladder-btn" + (opt === nearest ? " on" : "");
    b.textContent = String(opt);
    b.onclick = () => {
      val.textContent = `${opt}px`;
      row
        .querySelectorAll(".ladder-btn")
        .forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      void setSizeStep(opt).catch((e) => toast(String(e)));
    };
    row.appendChild(b);
  }
  wrap.append(head, row);
  return wrap;
}

export function autostartRow(): HTMLDivElement {
  const autoRow = document.createElement("div");
  autoRow.className = "auto-row";
  const autoLabel = document.createElement("span");
  autoLabel.textContent = "开机自启";
  const autoToggle = document.createElement("button");
  autoToggle.className = "auto-toggle";
  autoToggle.setAttribute("aria-pressed", "false");
  autoRow.append(autoLabel, autoToggle);

  void getAutostart()
    .then((on) => {
      autoToggle.classList.toggle("on", on);
      autoToggle.setAttribute("aria-pressed", String(on));
    })
    .catch(() => {});
  autoToggle.onclick = () => {
    const next = !autoToggle.classList.contains("on");
    autoToggle.classList.toggle("on", next);
    autoToggle.setAttribute("aria-pressed", String(next));
    void setAutostart(next).catch((e) => toast(String(e)));
  };
  return autoRow;
}

export async function buildAppearancePop(
  withAutostart: boolean,
): Promise<HTMLDivElement> {
  const pop = document.createElement("div");
  pop.className = "ctx opacity-pop";

  try {
    const st = await getWindowState();

    pop.appendChild(
      sliderRow({
        label: "面板透明度",
        initial: clamp01(st.bgOpacity),
        min: 0,
        max: 1,
        stepSize: 0.01,
        onLive: (v) => applyPanelAlpha(v),
        onCommit: (v) => setBgOpacity(v),
      }),
    );
    pop.appendChild(stepLadderRow(st.sizeStep));
    if (withAutostart) pop.appendChild(autostartRow());
  } catch {
    /* window state unavailable */
  }

  return pop;
}

export async function openAppearanceMenu(
  anchor: HTMLElement,
  withAutostart: boolean,
): Promise<void> {
  const rect = anchor.getBoundingClientRect();
  const pop = await buildAppearancePop(withAutostart);
  pop.style.left = `${Math.max(8, rect.right - 232)}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  document.body.appendChild(pop);
}

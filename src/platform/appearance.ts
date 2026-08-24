import { getCurrentWebview } from "@tauri-apps/api/webview";
import { applyPanelAlpha, applyTheme, toast } from "./shell";
import {
  getAutostart,
  getWindowState,
  setAutostart,
  setBgOpacity,
  setFontSizes,
  setTextEffect,
  setTheme,
  setSizeStep,
  type FontSizes,
  type ThemeCfg,
  type TextEffectLevel,
} from "./winstate";

/** 四类字号默认值（px），与 glass.css :root 中 --fs-* 保持一致 */
const FONT_DEFAULTS: FontSizes = { ui: 12.5, title: 14, small: 11, value: 13.5 };

/** 把四类字号写到根节点 CSS 变量，立即生效 */
function applyFontSizes(s: FontSizes): void {
  const st = document.documentElement.style;
  st.setProperty("--fs-ui", `${s.ui}px`);
  st.setProperty("--fs-title", `${s.title}px`);
  st.setProperty("--fs-small", `${s.small}px`);
  st.setProperty("--fs-value", `${s.value}px`);
}

/** 可读性增强档位写入 html[data-stroke]：off/std/max，未知值回退 std */
function applyTextEffect(level: string): void {
  document.documentElement.dataset.stroke =
    level === "off" || level === "max" ? level : "std";
}

/** 每个窗口启动时调用一次：应用全局外观并监听变更广播 */
export function initAppearance(): void {
  try {
    void getWindowState()
      .then((st) => {
        applyPanelAlpha(st.bgOpacity);
        applyTheme(st);
        applyTextEffect(st.textEffect ?? "std");
        applyFontSizes({
          ui: st.fontSizeUi ?? FONT_DEFAULTS.ui,
          title: st.fontSizeTitle ?? FONT_DEFAULTS.title,
          small: st.fontSizeSmall ?? FONT_DEFAULTS.small,
          value: st.fontSizeValue ?? FONT_DEFAULTS.value,
        });
      })
      .catch(() => applyPanelAlpha(0.55));
  } catch {
    applyPanelAlpha(0.55);
  }
  void getCurrentWebview()
    .listen<number>("bg-opacity", (ev) => applyPanelAlpha(ev.payload))
    .catch(() => {});
  void getCurrentWebview()
    .listen<ThemeCfg>("theme", (ev) => applyTheme(ev.payload ?? {}))
    .catch(() => {});
  void getCurrentWebview()
    .listen<string>("text-effect", (ev) => applyTextEffect(ev.payload))
    .catch(() => {});
  void getCurrentWebview()
    .listen<Partial<FontSizes>>("font-sizes", (ev) =>
      applyFontSizes({ ...FONT_DEFAULTS, ...ev.payload }),
    )
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

/** 24 色调色板（含默认背景 #282837 与品牌蓝 #4d6bfe） */
const PALETTE_24 = [
  "#ffffff",
  "#c9d1d9",
  "#8b949e",
  "#57606a",
  "#282837",
  "#11131a",
  "#000000",
  "#ff6b6b",
  "#ff8a3d",
  "#ffb84d",
  "#ffd166",
  "#a3e635",
  "#34d399",
  "#10b981",
  "#2dd4bf",
  "#22d3ee",
  "#38bdf8",
  "#3b82f6",
  "#4d6bfe",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#f472b6",
  "#f43f5e",
];

/** 各主题项的展示用兜底色（未自定义时高亮该色） */
const THEME_FALLBACK: Required<ThemeCfg> = {
  fontColor: "#ffffff",
  bgColor: "#282837",
};

/** 两组色板：字体 / 背景（小字色由字体色自动派生） */
function buildThemeRows(initial: Required<ThemeCfg>): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "theme-box";
  const paints: Array<() => void> = [];

  const mkRow = (labelText: string, key: keyof ThemeCfg): void => {
    const head = document.createElement("div");
    head.className = "opacity-head";
    const title = document.createElement("span");
    title.textContent = labelText;
    head.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "swatch-grid";
    const paint = (): void => {
      grid.querySelectorAll<HTMLButtonElement>(".swatch").forEach((el) => {
        el.classList.toggle("on", el.dataset.c === initial[key]);
      });
    };
    for (const c of PALETTE_24) {
      const s = document.createElement("button");
      s.className = "swatch";
      s.style.background = c;
      s.dataset.c = c;
      s.title = c;
      s.onclick = () => {
        initial[key] = c;
        paint();
        applyTheme(initial);
        void setTheme(initial).catch((e) => toast(String(e)));
      };
      grid.appendChild(s);
    }
    paint();
    paints.push(paint);
    box.append(head, grid);
  };

  mkRow("字体颜色", "fontColor");
  mkRow("背景颜色", "bgColor");

  const reset = document.createElement("button");
  reset.className = "theme-reset";
  reset.textContent = "恢复默认配色";
  reset.onclick = () => {
    initial.fontColor = THEME_FALLBACK.fontColor;
    initial.bgColor = THEME_FALLBACK.bgColor;
    paints.forEach((p) => p());
    applyTheme({});
    void setTheme({}).catch((e) => toast(String(e)));
  };
  box.appendChild(reset);

  return box;
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

/** 弹窗内分组标题 */
function sectionLabel(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "pop-section";
  el.textContent = text;
  return el;
}

/** 字号滑条：拖动实时预览（写 CSS 变量），停止后持久化整组字号 */
function fontSliderRow(
  labelText: string,
  key: keyof FontSizes,
  initial: number,
  min: number,
  max: number,
  sizes: FontSizes,
): HTMLDivElement {
  return sliderRow({
    label: labelText,
    initial,
    min,
    max,
    stepSize: 0.5,
    format: (v) => `${v}px`,
    onLive: (v) => applyFontSizes({ ...sizes, [key]: v }),
    onCommit: (v) => {
      sizes[key] = v;
      return setFontSizes(sizes);
    },
  });
}

/** 可读性增强三档：关闭 / 标准（细描边+阴影）/ 强化（粗描边+深阴影） */
const READABILITY_LEVELS: Array<{ v: TextEffectLevel; label: string }> = [
  { v: "off", label: "关闭" },
  { v: "std", label: "标准" },
  { v: "max", label: "强化" },
];

function readabilityRow(initial: string): HTMLDivElement {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "opacity-head";
  head.title = "描边+阴影让文字在浅色或复杂壁纸上保持清晰";
  const title = document.createElement("span");
  title.textContent = "可读性增强";
  head.appendChild(title);

  const row = document.createElement("div");
  row.className = "ladder-row";
  for (const opt of READABILITY_LEVELS) {
    const b = document.createElement("button");
    b.className = "ladder-btn" + (opt.v === initial ? " on" : "");
    b.textContent = opt.label;
    b.onclick = () => {
      row
        .querySelectorAll(".ladder-btn")
        .forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      applyTextEffect(opt.v);
      void setTextEffect(opt.v).catch((e) => toast(String(e)));
    };
    row.appendChild(b);
  }
  wrap.append(head, row);
  return wrap;
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
    pop.appendChild(
      buildThemeRows({
        fontColor: st.fontColor || THEME_FALLBACK.fontColor,
        bgColor: st.bgColor || THEME_FALLBACK.bgColor,
      }),
    );

    // 字号设置：四类字体分别调节，拖动即时预览
    const sizes: FontSizes = {
      ui: st.fontSizeUi ?? FONT_DEFAULTS.ui,
      title: st.fontSizeTitle ?? FONT_DEFAULTS.title,
      small: st.fontSizeSmall ?? FONT_DEFAULTS.small,
      value: st.fontSizeValue ?? FONT_DEFAULTS.value,
    };
    pop.appendChild(sectionLabel("字号设置"));
    pop.appendChild(fontSliderRow("界面字体", "ui", sizes.ui, 10, 18, sizes));
    pop.appendChild(fontSliderRow("标题字体", "title", sizes.title, 11, 22, sizes));
    pop.appendChild(fontSliderRow("辅助小字", "small", sizes.small, 9, 16, sizes));
    pop.appendChild(fontSliderRow("数值字体", "value", sizes.value, 12, 24, sizes));

    const fsReset = document.createElement("button");
    fsReset.className = "theme-reset";
    fsReset.textContent = "恢复默认字号";
    fsReset.onclick = () => {
      Object.assign(sizes, FONT_DEFAULTS);
      applyFontSizes(sizes);
      void setFontSizes(sizes).catch((e) => toast(String(e)));
    };
    const fsWrap = document.createElement("div");
    fsWrap.style.marginTop = "8px";
    fsWrap.appendChild(fsReset);
    pop.appendChild(fsWrap);

    // 可读性增强：三档描边+阴影
    pop.appendChild(sectionLabel("文字效果"));
    pop.appendChild(readabilityRow(st.textEffect ?? "std"));
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
  document.body.appendChild(pop);
  // 内容变多后可能超出窗口底部：按实际高度向上收，保持完整可见
  const h = pop.getBoundingClientRect().height;
  pop.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - h - 8))}px`;
}

/**
 * 番茄钟预览入口：用 Tauri 桩在浏览器里挂载真实组件代码，
 * 便于截图核对各状态的视觉表现。
 *   ?scene=idle|focus|ripe|rest|longrest|task|stats|picker|nomemo|full|settings
 */
import "../../src/styles/glass.css";
import { initAppearance } from "../../src/platform/appearance";
import { getWidget } from "../../src/platform/registry";
import "../../src/widgets/pomodoro";

function click(selector: string): void {
  document.querySelector<HTMLElement>(selector)?.click();
}

async function boot(): Promise<void> {
  initAppearance();
  const def = getWidget("pomodoro");
  const q = new URLSearchParams(location.search);

  // 拼图模式：一页并排渲染多组尺寸，用于核对各种窗口大小下的排版
  const grid = document.getElementById("grid");
  if (grid && q.get("grid") === "1") {
    document.getElementById("app")?.remove();
    const sizes: Array<[number, number]> = [
      [240, 340],
      [260, 380],
      [280, 420],
      [300, 460],
      [320, 520],
      [320, 400],
      [340, 560],
      [360, 600],
    ];
    for (const [w, h] of sizes) {
      const cell = document.createElement("div");
      cell.className = "pm-cell pm-window";
      cell.dataset.size = `${w}x${h}`;
      cell.style.width = `${w}px`;
      cell.style.height = `${h}px`;
      grid.appendChild(cell);
      await def.mount(cell, { windowLabel: "w-pomodoro", embedded: false });
    }
    return;
  }

  const app = document.getElementById("app");
  if (!app || !def) return;
  // 固定窗口尺寸：让预览与真实小组件窗口一致（不受浏览器 DPI 影响）
  app.style.width = `${Number(q.get("w") ?? 320)}px`;
  app.style.height = `${Number(q.get("h") ?? 520)}px`;
  await def.mount(app, { windowLabel: "w-pomodoro", embedded: false });
  // 等首帧数据加载 + 一帧布局，再触发面板类场景
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  const scene = String(
    (window as unknown as { __PREVIEW_SCENE__?: string }).__PREVIEW_SCENE__ ??
      "idle",
  );
  if (scene === "stats" || scene === "legacy-stats") click("#header .icon-btn");
  if (scene === "picker" || scene === "nomemo") click(".pm-task-main");
  if (scene === "settings") click("#header .icon-btn:nth-of-type(2)");
  if (q.get("probe") === "1") {
    // 探针模式：把关键元素矩形写进 <title>，供 check-layout.mjs 读取
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    document.title = probeJson();
  }
  if (q.get("debug") === "1") {
    const stage = document.querySelector<HTMLElement>(".pm-stage");
    const box = document.querySelector<HTMLElement>(".pm-ringbox");
    const fruit = document.querySelector<SVGPathElement>(".pm-scene .pm-body");
    const ring = document.querySelector<SVGCircleElement>(".pm-scene .pm-ring-fg");
    const info = document.createElement("div");
    info.style.cssText =
      "position:fixed;left:0;bottom:0;z-index:999;font:11px monospace;" +
      "color:#9f9;background:#000d;padding:3px 6px;white-space:pre;line-height:1.3";
    document.body.appendChild(info);
    const paintInfo = (): void => {
      const cs = getComputedStyle(app);
      const overlay = document.querySelector<HTMLElement>(".overlay");
      const sheet = document.querySelector<HTMLElement>(".pm-sheet");
      const or = overlay?.getBoundingClientRect();
      const sr = sheet?.getBoundingClientRect();
      const rect = (r?: DOMRect): string =>
        r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "-";
      info.textContent = [
        `app ${app.clientWidth}x${app.clientHeight} stage ${stage?.clientWidth}x${stage?.clientHeight} ring ${box?.style.width} fit ${cs.getPropertyValue("--pm-fit").trim()}`,
        `ripe ${cs.getPropertyValue("--pm-ripe").trim()} scale ${cs.getPropertyValue("--pm-scale").trim()} state ${app.dataset.state ?? "-"}`,
        `fill ${fruit ? getComputedStyle(fruit).fill : "-"}`,
        `dashoffset ${ring?.style.strokeDashoffset ?? "-"} dasharray ${ring?.style.strokeDasharray ?? "-"}`,
        `viewport ${window.innerWidth}x${window.innerHeight} overlay ${rect(or)} sheet ${rect(sr)}`,
        checkOverlap(),
      ].join("\n");
    };
    paintInfo();
    window.setInterval(paintInfo, 150);
  }
}

/** 关键元素矩形快照（探针模式用，供 check-layout.mjs 解析） */
function probeJson(): string {
  const q = (
    sel: string,
  ): { l: number; t: number; w: number; h: number; b: number; r: number } | null => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = (v: number): number => Number(v.toFixed(1));
    return { l: f(r.left), t: f(r.top), w: f(r.width), h: f(r.height), b: f(r.bottom), r: f(r.right) };
  };
  /** 文本实际尺寸：内层 span 才是文字本身的盒子 */
  const textBox = (
    sel: string,
  ): { l: number; t: number; w: number; h: number; b: number; r: number } | null =>
    q(sel);
  const app = document.getElementById("app");
  return JSON.stringify({
    app: app
      ? {
          w: app.clientWidth,
          h: app.clientHeight,
          t: Number(app.getBoundingClientRect().top.toFixed(1)),
          b: Number(app.getBoundingClientRect().bottom.toFixed(1)),
        }
      : null,
    fit: app ? getComputedStyle(app).getPropertyValue("--pm-fit").trim() : "",
    tabs: q(".pm-tabs"),
    time: q(".pm-time"),
    timeTextW: textBox(".pm-time span")?.w ?? 0,
    statusTextW: textBox(".pm-status span")?.w ?? 0,
    status: q(".pm-status"),
    task: q(".pm-task"),
    controls: q(".pm-controls"),
    field: q(".pm-field"),
    ringbox: q(".pm-ringbox"),
    // 时间/状态文字本身的矩形（内层 span 才是文字尺寸）
    timeInner: q(".pm-time span"),
    statusInner: q(".pm-status span"),
    // 状态行的位置（新设计：位于圆环下方）
  });
}

/** 检测关键元素是否重叠/溢出：既输出到调试读数，也挂到 window 供自动化读取 */
function checkOverlap(): string {
  const pick = (sel: string): DOMRect | null =>
    document.querySelector<HTMLElement>(sel)?.getBoundingClientRect() ?? null;
  const items: Array<[string, DOMRect | null]> = [
    ["time", pick(".pm-time")],
    ["status", pick(".pm-status")],
    ["task", pick(".pm-task")],
    ["controls", pick(".pm-controls")],
    ["field", pick(".pm-field")],
    ["crops", pick(".pm-crops")],
    ["ringbox", pick(".pm-ringbox")],
  ];
  const issues: string[] = [];
  const hit = (a: DOMRect, b: DOMRect): boolean =>
    a.right > b.left + 1 && b.right > a.left - 1 && a.bottom > b.top + 1;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [na, a] = items[i];
      const [nb, b] = items[j];
      if (!a || !b || a.width === 0 || b.width === 0) continue;
      if (hit(a, b)) issues.push(`${na}×${nb}`);
    }
  }
  const app = document.getElementById("app");
  const limit = app ? app.getBoundingClientRect().bottom : 0;
  for (const [n, r] of items) {
    if (r && r.width > 0 && r.bottom > limit + 0.5) issues.push(`${n}溢出底部`);
  }
  const result = issues.length === 0 ? "重叠检查 PASS" : `重叠: ${issues.join(", ")}`;
  (window as unknown as { __OVERLAP__?: string }).__OVERLAP__ = result;
  return result;
}

void boot();

import "./../../styles/taskbar.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { registerWidget, type WidgetContext } from "../../platform/registry";
import {
  getNativeBar,
  setNativeBar,
  type NativeBarCfg,
} from "../../platform/winstate";

// ---------------- 原生任务栏风格替换（开关卡） ----------------
//
// 本窗口可见期间，后端对 Explorer 原生任务栏持续应用配置的材质与色调；
// 窗口关闭（隐藏）即自动还原系统默认。这里只负责参数调节与状态展示，
// 生效逻辑完全在后端 nativebar 模块，不依赖前端存活。

const MODES: Array<[NativeBarCfg["mode"], string]> = [
  ["clear", "透明"],
  ["blur", "模糊"],
  ["acrylic", "亚克力"],
  ["solid", "纯色"],
];

/** 24 色调色板（含默认背景 #282837），与外观弹窗共用同一组色 */
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

const MODE_LABEL = new Map(MODES);

interface CardEls {
  modeText: HTMLElement;
  modes: HTMLDivElement;
  follow: HTMLButtonElement;
  colors: HTMLDivElement;
  opValue: HTMLElement;
  opacity: HTMLInputElement;
}
let els: CardEls | null = null;

function schedulePersist(cfg: NativeBarCfg): void {
  // 立即保存即可：滑条拖动频率下写盘开销可忽略，且后端同步本身幂等
  void setNativeBar({ ...cfg }).catch(() => {});
}

function paint(cfg: NativeBarCfg): void {
  if (!els) return;
  const label = MODE_LABEL.get(cfg.mode) ?? cfg.mode;
  els.modeText.textContent = `替换生效中 · ${label}`;
  els.modes.querySelectorAll(".ladder-btn").forEach((el) => {
    el.classList.toggle("on", (el as HTMLElement).dataset.m === cfg.mode);
  });
  els.follow.classList.toggle("on", cfg.followTheme);
  els.follow.setAttribute("aria-pressed", String(cfg.followTheme));
  els.colors.querySelectorAll<HTMLButtonElement>(".swatch").forEach((el) => {
    el.classList.toggle("on", el.dataset.c === cfg.tint);
  });
  els.opacity.value = String(Math.round(cfg.opacity * 100));
  els.opValue.textContent = `${Math.round(cfg.opacity * 100)}%`;
}

async function mountTaskbarCard(root: HTMLElement): Promise<() => void> {
  document.body.classList.add("tb-body");

  root.innerHTML = `
    <div class="tbc">
      <div class="tbc-status">
        <span class="tbc-dot"></span>
        <span id="tbc-state">替换生效中</span>
      </div>
      <div class="pop-section">材质</div>
      <div class="ladder-row" id="tbc-modes"></div>
      <div class="auto-row" style="margin-top:10px;">
        <span style="flex:1;font-size:var(--fs-small);color:var(--text-dim);">色调跟随应用背景色</span>
        <button class="auto-toggle" id="tbc-follow" aria-pressed="false"></button>
      </div>
      <div class="swatch-grid" id="tbc-colors" style="grid-template-columns:repeat(12,1fr);margin-bottom:0;"></div>
      <div class="opacity-head" style="margin-top:10px;">
        <span>不透明度</span>
        <span class="opacity-val" id="tbc-opv">--</span>
      </div>
      <input type="range" class="opacity-slider" id="tbc-op" min="0" max="100" step="1" />
      <div class="tbc-hint">打开本卡片即替换系统原生任务栏外观；关闭卡片立即还原默认。主面板外观菜单也可调整同样参数。</div>
    </div>
  `;

  const cfg = await getNativeBar();

  const q = <T extends HTMLElement>(sel: string): T =>
    root.querySelector<T>(sel)!;
  els = {
    modeText: q("#tbc-state"),
    modes: q("#tbc-modes"),
    follow: q<HTMLButtonElement>("#tbc-follow"),
    colors: q("#tbc-colors"),
    opValue: q("#tbc-opv"),
    opacity: q<HTMLInputElement>("#tbc-op"),
  };

  for (const [m, label] of MODES) {
    const b = document.createElement("button");
    b.className = "ladder-btn";
    b.dataset.m = m;
    b.textContent = label;
    b.onclick = () => {
      cfg.mode = m;
      paint(cfg);
      schedulePersist(cfg);
    };
    els.modes.appendChild(b);
  }

  for (const c of PALETTE_24) {
    const s = document.createElement("button");
    s.className = "swatch";
    s.style.background = c;
    s.dataset.c = c;
    s.title = c;
    s.onclick = () => {
      cfg.tint = c;
      paint(cfg);
      schedulePersist(cfg);
    };
    els.colors.appendChild(s);
  }

  els.follow.onclick = () => {
    cfg.followTheme = !cfg.followTheme;
    paint(cfg);
    schedulePersist(cfg);
  };
  els.opacity.oninput = () => {
    cfg.opacity = Number(els!.opacity.value) / 100;
    els!.opValue.textContent = `${els!.opacity.value}%`;
    schedulePersist(cfg);
  };

  paint(cfg);

  // 外观弹窗里的修改通过事件回流，保持卡片显示同步
  const unlisten = await getCurrentWebview()
    .listen<NativeBarCfg>("native-bar", (ev) => {
      Object.assign(cfg, ev.payload);
      paint(cfg);
    })
    .catch(() => () => {});

  return () => {
    unlisten();
    document.body.classList.remove("tb-body");
    els = null;
  };
}

registerWidget({
  id: "taskbar",
  name: "任务栏",
  icon: "🖥️",
  color: "#7dd3fc",
  desc: "原生任务栏风格替换：开启即应用材质与色调，关闭恢复系统默认",
  width: 300,
  height: 320,
  minWidth: 250,
  minHeight: 280,
  mount: (root: HTMLElement, _ctx: WidgetContext) => mountTaskbarCard(root),
});

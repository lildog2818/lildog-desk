export function applyPanelAlpha(v: number): void {
  document.documentElement.style.setProperty("--panel-a", String(v));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 由背景色派生面板三段渐变用的 "r,g,b" 三元组（亮部/暗部/暖部） */
export function deriveBgTriplets(hex: string): {
  c1: string;
  c2: string;
  c3: string;
} {
  const rgb = hexToRgb(hex) ?? [40, 40, 55];
  const cl = (n: number): number =>
    Math.round(Math.min(255, Math.max(0, n)));
  const mixW = (c: number, k: number): number => cl(c + (255 - c) * k);
  const c1 = `${mixW(rgb[0], 0.1)},${mixW(rgb[1], 0.1)},${mixW(rgb[2], 0.16)}`;
  const c2 = `${cl(rgb[0] * 0.45)},${cl(rgb[1] * 0.45)},${cl(rgb[2] * 0.52)}`;
  const c3 = `${cl(rgb[0] * 0.8)},${cl(rgb[1] * 0.74)},${cl(
    Math.min(255, rgb[2] * 1.02 + 8),
  )}`;
  return { c1, c2, c3 };
}

/** 应用主题色到当前窗口；空值表示恢复默认 */
export function applyTheme(t: {
  textMain?: string | null;
  textDim?: string | null;
  bgColor?: string | null;
}): void {
  const rootStyle = document.documentElement.style;
  const putColor = (name: string, v?: string | null): void => {
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) rootStyle.setProperty(name, v);
    else rootStyle.removeProperty(name);
  };
  putColor("--text", t.textMain ?? null);
  putColor("--text-dim", t.textDim ?? null);

  const bg = t.bgColor ?? null;
  if (bg && /^#[0-9a-fA-F]{6}$/.test(bg)) {
    const { c1, c2, c3 } = deriveBgTriplets(bg);
    rootStyle.setProperty("--bg-c1", c1);
    rootStyle.setProperty("--bg-c2", c2);
    rootStyle.setProperty("--bg-c3", c3);
  } else {
    rootStyle.removeProperty("--bg-c1");
    rootStyle.removeProperty("--bg-c2");
    rootStyle.removeProperty("--bg-c3");
  }
}

let pulseInstalled = false;

/** 窗口尺寸变化停止后弹跳一下（阶梯吸附落位反馈），拖动过程中不触发以免抽搐 */
export function installResizePulse(): void {
  if (pulseInstalled) return;
  pulseInstalled = true;
  let settleTimer = 0;
  let popTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      const app = document.getElementById("app");
      if (!app) return;
      app.classList.remove("size-pop");
      void app.offsetWidth; // 重置动画
      app.classList.add("size-pop");
      window.clearTimeout(popTimer);
      popTimer = window.setTimeout(() => app.classList.remove("size-pop"), 260);
    }, 180);
  });
}

export function toast(msg: string): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  const prev = Number((el as HTMLElement & { _t?: number })._t ?? 0);
  window.clearTimeout(prev);
  el.textContent = msg;
  el.classList.add("show");
  const t = window.setTimeout(() => el.classList.remove("show"), 1600);
  (el as HTMLElement & { _t?: number })._t = t;
}

export function closeMenus(): void {
  document.querySelectorAll(".ctx").forEach((m) => m.remove());
}

export function closeOverlays(): void {
  closeMenus();
  document.querySelectorAll(".overlay").forEach((o) => o.remove());
}

export interface MenuEntry {
  label?: string;
  danger?: boolean;
  action?: () => void;
  sub?: Array<{ label: string; action: () => void }>;
}

export function buildMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "ctx";
  for (const e of entries) {
    if (e.sub) {
      const row = document.createElement("div");
      row.className = "ctx-item ctx-has";
      row.textContent = e.label ?? "";
      const arrow = document.createElement("span");
      arrow.textContent = "›";
      arrow.style.opacity = "0.5";
      row.appendChild(arrow);
      const sub = document.createElement("div");
      sub.className = "ctx-sub";
      for (const s of e.sub) {
        const sr = document.createElement("div");
        sr.className = "ctx-item";
        sr.textContent = s.label;
        sr.onclick = () => {
          closeMenus();
          s.action();
        };
        sub.appendChild(sr);
      }
      row.appendChild(sub);
      menu.appendChild(row);
      continue;
    }
    if (e.label === undefined && !e.action) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = e.danger ? "ctx-item danger" : "ctx-item";
    row.textContent = e.label ?? "";
    row.onclick = () => {
      closeMenus();
      e.action?.();
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

export function modal(
  title: string,
  fields: HTMLDivElement[],
  buttons: HTMLButtonElement[],
): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);
  for (const f of fields) box.appendChild(f);
  const bar = document.createElement("div");
  bar.className = "dialog-btns";
  for (const b of buttons) bar.appendChild(b);
  box.appendChild(bar);
  overlay.appendChild(box);
  overlay.onpointerdown = (ev) => {
    if (ev.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
  const input = box.querySelector<HTMLInputElement>("input");
  if (input) {
    input.focus();
    input.select();
  }
}

export function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

export function textInput(value: string, placeholder = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

export function button(label: string, cls: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.onclick = () => onClick?.();
  return b;
}

export function promptText(
  title: string,
  initial: string,
  commit: (value: string) => void,
): void {
  const input = textInput(initial);
  const ok = () => {
    const v = input.value.trim();
    if (v) commit(v);
    closeOverlays();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") ok();
  };
  modal(title, [field("名称", input)], [
    button("取消", "", () => closeOverlays()),
    button("确定", "primary", ok),
  ]);
}

export function confirmDanger(message: string, commit: () => void): void {
  const note = document.createElement("div");
  note.className = "path-note";
  note.textContent = message;
  modal("确认操作", [note], [
    button("取消", "", () => closeOverlays()),
    button("删除", "danger", () => {
      closeOverlays();
      commit();
    }),
  ]);
}

export function iconButton(title: string, glyph: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.title = title;
  b.textContent = glyph;
  return b;
}

let dismissInstalled = false;

export function installGlobalDismiss(): void {
  if (dismissInstalled) return;
  dismissInstalled = true;
  document.addEventListener("pointerdown", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest(".ctx")) closeMenus();
    if (!t.closest(".overlay,.ctx")) closeOverlays();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeOverlays();
  });
}

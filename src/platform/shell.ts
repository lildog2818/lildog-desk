export function applyPanelAlpha(v: number): void {
  document.documentElement.style.setProperty("--panel-a", String(v));
}

let pulseInstalled = false;

/** 窗口尺寸变化时的动态放大反馈：面板轻微弹跳一下 */
export function installResizePulse(): void {
  if (pulseInstalled) return;
  pulseInstalled = true;
  let timer = 0;
  window.addEventListener("resize", () => {
    const app = document.getElementById("app");
    if (!app) return;
    app.classList.remove("size-pop");
    void app.offsetWidth; // 重置动画
    app.classList.add("size-pop");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => app.classList.remove("size-pop"), 260);
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

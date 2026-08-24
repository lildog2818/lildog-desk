import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface ShotContext {
  originX: number;
  originY: number;
  scale: number;
  width: number;
  height: number;
  target: number;
}

/** 区域截图覆盖层：拖拽框选 → 物理坐标回传；Esc / 右键取消 */
export function mountShotOverlay(root: HTMLElement): void {
  document.documentElement.dataset.chrome = "none";
  root.innerHTML = `
    <div id="shot-veil"></div>
    <div id="shot-rect"></div>
    <div id="shot-hint">拖拽框选截图 · Esc 取消</div>
  `;

  const veil = root.querySelector<HTMLElement>("#shot-veil")!;
  const rect = root.querySelector<HTMLElement>("#shot-rect")!;
  let ctx: ShotContext | null = null;
  let sx = 0;
  let sy = 0;
  let active = false;

  const cancel = (): void => {
    active = false;
    rect.style.display = "none";
    void invoke("cancel_shot").catch(() => {});
  };

  veil.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    cancel();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") cancel();
  });

  const draw = (cx: number, cy: number): void => {
    const x = Math.min(sx, cx);
    const y = Math.min(sy, cy);
    rect.style.left = `${x}px`;
    rect.style.top = `${y}px`;
    rect.style.width = `${Math.abs(cx - sx)}px`;
    rect.style.height = `${Math.abs(cy - sy)}px`;
  };

  veil.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    active = true;
    sx = ev.clientX;
    sy = ev.clientY;
    rect.style.display = "block";
    draw(sx, sy);
    void veil.setPointerCapture(ev.pointerId);
  });
  veil.addEventListener("pointermove", (ev) => {
    if (!active) return;
    draw(ev.clientX, ev.clientY);
  });
  const finish = (e: PointerEvent): void => {
    if (!active) return;
    active = false;
    rect.style.display = "none";
    const w = Math.abs(e.clientX - sx);
    const h = Math.abs(e.clientY - sy);
    if (!ctx || w < 6 || h < 6) {
      // 太小的框视为误触，取消
      cancel();
      return;
    }
    const s = ctx.scale || 1;
    void invoke("commit_shot_rect", {
      x: Math.round(ctx.originX + Math.min(sx, e.clientX) * s),
      y: Math.round(ctx.originY + Math.min(sy, e.clientY) * s),
      w: Math.round(w * s),
      h: Math.round(h * s),
    }).catch(() => {});
  };
  veil.addEventListener("pointerup", finish);
  veil.addEventListener("pointercancel", () => {
    active = false;
    rect.style.display = "none";
  });

  void getCurrentWebview()
    .listen<ShotContext>("shot-context", (ev) => {
      ctx = ev.payload;
    })
    .catch(() => {});
}

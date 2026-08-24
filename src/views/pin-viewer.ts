import { invoke } from "@tauri-apps/api/core";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildMenu } from "../platform/shell";

interface PinPayload {
  path: string;
  width: number;
  height: number;
}

/** 贴图窗：拖动移动 / 滚轮缩放 / 双击或 Esc 关闭 */
export function mountPinViewer(root: HTMLElement): void {
  document.documentElement.dataset.chrome = "none";
  root.innerHTML = `
    <div class="pin-wrap" id="pin-wrap">
      <img id="pin-img" alt="" draggable="false" />
      <button class="pin-close" id="pin-close" title="关闭">✕</button>
    </div>
  `;

  const win = getCurrentWindow();
  const wrap = root.querySelector<HTMLElement>("#pin-wrap")!;
  const img = root.querySelector<HTMLImageElement>("#pin-img")!;
  let curW = 200;
  let curH = 150;
  let lastPath = "";

  const close = (): void => {
    void win.close();
  };
  root.querySelector("#pin-close")!.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
  });
  root.querySelector("#pin-close")!.addEventListener("click", (ev) => {
    ev.stopPropagation();
    close();
  });
  wrap.addEventListener("dblclick", () => close());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  // 整窗拖动（关闭按钮除外）
  wrap.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement).id === "pin-close") return;
    void win.startDragging();
  });

  // 滚轮缩放：等比调整窗口物理尺寸
  wrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const f = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      let nw = Math.round(curW * f);
      nw = Math.max(48, Math.min(4000, nw));
      const nh = Math.max(32, Math.min(4000, Math.round((curH * nw) / curW)));
      curW = nw;
      curH = nh;
      void win.setSize(new PhysicalSize(nw, nh)).catch(() => {});
    },
    { passive: false },
  );

  wrap.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    buildMenu(ev.clientX, ev.clientY, [
      {
        label: "复制图片",
        action: () => {
          void invoke("write_clipboard_image", { path: lastPath })
            .then(() => {})
            .catch((e) => console.error(e));
        },
      },
      { label: "关闭贴图", action: () => close() },
    ]);
  });

  // 接收后端推送的图片
  void getCurrentWebview()
    .listen<PinPayload>("pin-image", async (ev) => {
      const p = ev.payload;
      lastPath = p.path;
      try {
        img.src = await invoke<string>("clip_image_data_url", {
          path: p.path,
          maxEdge: 0,
        });
        const sz = await win.outerSize();
        curW = sz.width;
        curH = sz.height;
      } catch (e) {
        console.error("加载贴图失败", e);
      }
    })
    .catch(() => {});
}

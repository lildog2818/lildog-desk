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
  let loaded = false;

  const close = (): void => {
    win.close().catch(() => {});
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
    const entries: Array<{ label?: string; action?: () => void }> = [
      {
        label: "复制图片",
        action: () => {
          void invoke("write_clipboard_image", { path: lastPath }).catch((e) =>
            console.error(e),
          );
        },
      },
      { label: undefined, action: undefined },
      { label: "关闭贴图", action: () => close() },
    ];
    buildMenu(ev.clientX, ev.clientY, entries);
  });

  const apply = async (p: PinPayload): Promise<void> => {
    if (loaded) return;
    loaded = true;
    lastPath = p.path;
    try {
      img.src = await invoke<string>("clip_image_data_url", {
        path: p.path,
        maxEdge: 0,
      });
      const sz = await win.outerSize();
      curW = Math.max(48, sz.width);
      curH = Math.max(32, sz.height);
    } catch (e) {
      console.error("加载贴图失败", e);
    }
  };

  // 加速路径：后端在窗口就绪前 emit 的载荷
  void getCurrentWebview()
    .listen<PinPayload>("pin-image", (ev) => {
      if (ev.payload && ev.payload.path) void apply(ev.payload);
    })
    .catch(() => {});

  // 兜底路径（消除竞态）：前端就绪后主动拉取属于自己的载荷
  void invoke<PinPayload | null>("take_pin_payload")
    .then((p) => {
      if (p && p.path) void apply(p);
    })
    .catch(() => {});
}

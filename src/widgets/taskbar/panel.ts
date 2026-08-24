// 快捷设置面板（taskbar-panel 窗口）：仿系统快速设置布局。
// settings 模式 = WLAN/蓝牙/飞行模式磁贴 + 主音量滑条 + 设置入口；
// picker 模式 = 从开始菜单选应用固定到任务栏。

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { showAppPicker } from "../launcher/actions";
import { VOL_ICON, type BarData, type Pin } from "./index";

const ICONS = {
  wifi: '<svg viewBox="0 0 24 24"><path d="M12 19.6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8.4 14.4a5.2 5.2 0 0 1 7.2 0M5.4 11.3a9.4 9.4 0 0 1 13.2 0M2.5 8.2a13.6 13.6 0 0 1 19 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="M7.5 7.5l9 9-4.5 4V3.5l4.5 4-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  air: '<svg viewBox="0 0 24 24"><path d="M21 15.5v-2l-8.5-5V3.2a1.5 1.5 0 0 0-3 0V8.5L1 13.5v2l8.5-2.6v5.1L7 19.6V21l4.5-1.2L16 21v-1.4l-2.5-1.6v-5.1L21 15.5z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13c.05-.33.1-.66.1-1s-.05-.67-.1-1l2.1-1.6a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.6.26-1.17.6-1.7 1l-2.5-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.6 11c-.05.33-.1.66-.1 1s.05.67.1 1l-2.1 1.6a.5.5 0 0 0-.12.64l2 3.46c.13.22.4.31.6.22l2.5-1c.53.4 1.1.74 1.7 1l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.6-.26 1.17-.6 1.7-1l2.5 1c.23.09.48 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
};

interface NetStatus {
  online: boolean;
  kind: string;
  name: string;
}

interface AudioState {
  volume: number;
  muted: boolean;
}

function openSettings(page: string): void {
  void invoke("open_target", { target: `ms-settings:${page}` }).catch((e) =>
    toast(String(e)),
  );
}

// ---------------- settings 模式 ----------------

function renderSettings(box: HTMLElement): void {
  box.innerHTML = `
    <div class="tb-tiles">
      <button class="tb-tile" id="tile-wlan">
        <span class="tb-tile-ico">${ICONS.wifi}</span>
        <span class="tb-tile-name">WLAN</span>
        <span class="tb-tile-sub">正在读取…</span>
      </button>
      <button class="tb-tile" id="tile-bt">
        <span class="tb-tile-ico">${ICONS.bt}</span>
        <span class="tb-tile-name">蓝牙</span>
        <span class="tb-tile-sub">打开设置</span>
      </button>
      <button class="tb-tile" id="tile-air">
        <span class="tb-tile-ico">${ICONS.air}</span>
        <span class="tb-tile-name">飞行模式</span>
        <span class="tb-tile-sub">打开设置</span>
      </button>
    </div>
    <div class="tb-volrow">
      <button class="tb-mute" title="静音切换"></button>
      <input type="range" class="opacity-slider tb-volslider" min="0" max="100" step="1" value="50" />
    </div>
    <div class="tb-panel-foot">
      <button class="tb-gear" title="全部设置">${ICONS.gear}</button>
    </div>
  `;

  const wlanSub = box.querySelector<HTMLElement>("#tile-wlan .tb-tile-sub")!;
  const refreshNet = (): void => {
    void invoke<NetStatus>("get_network_status")
      .then((st) => {
        wlanSub.textContent = st.online
          ? st.name || "已连接"
          : "未连接";
        box
          .querySelector("#tile-wlan")
          ?.classList.toggle("off", !st.online);
      })
      .catch(() => {
        wlanSub.textContent = "未知";
      });
  };
  refreshNet();

  box.querySelector("#tile-wlan")!.addEventListener("click", () =>
    openSettings("network"),
  );
  box.querySelector("#tile-bt")!.addEventListener("click", () =>
    openSettings("bluetooth"),
  );
  box.querySelector("#tile-air")!.addEventListener("click", () =>
    openSettings("airplanemode"),
  );
  box.querySelector(".tb-gear")!.addEventListener("click", () =>
    openSettings(""),
  );

  // 音量：滑条实时调节，静音钮切换
  const slider = box.querySelector<HTMLInputElement>(".tb-volslider")!;
  const muteBtn = box.querySelector<HTMLButtonElement>(".tb-mute")!;
  let muted = false;
  let syncTimer = 0;

  const paintMute = (): void => {
    muteBtn.innerHTML = muted ? VOL_ICON.off : VOL_ICON.on;
    muteBtn.classList.toggle("muted", muted);
  };
  const refreshAudio = (): void => {
    void invoke<AudioState>("get_audio_state")
      .then((st) => {
        slider.value = String(Math.round(st.volume * 100));
        muted = st.muted;
        paintMute();
      })
      .catch(() => {});
  };
  refreshAudio();

  slider.addEventListener("input", () => {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      void invoke("set_audio_volume", {
        volume: Number(slider.value) / 100,
      }).catch((e) => toast(String(e)));
    }, 60);
  });
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    paintMute();
    void invoke("set_audio_mute", { mute: muted }).catch((e) =>
      toast(String(e)),
    );
  });
}

// ---------------- picker 模式 ----------------

function uid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

async function renderPicker(box: HTMLElement): Promise<void> {
  const data = await widgetLoad<BarData>("taskbar", { pins: [] });
  if (!Array.isArray(data.pins)) data.pins = [];

  const persist = (): Promise<void> =>
    widgetSave("taskbar", data).then(() => emit("tb-pins-changed"));

  showAppPicker({
    isAdded: (target) =>
      data.pins.some((p) => p.target.toLowerCase() === target.toLowerCase()),
    onPick: (a) => {
      const pin: Pin = {
        id: uid(),
        name: a.name,
        kind: a.kind,
        target: a.target,
        args: a.args,
        icon: null,
        exe: null,
      };
      data.pins.push(pin);
      void persist().catch(() => {});
      // 解析运行态 exe（lnk 内层目标），供「正在运行」点亮
      void invoke<{ name: string; exe: string }>("resolve_pin_target", {
        path: a.target,
      })
        .then((r) => {
          if (r?.exe) {
            pin.exe = r.exe;
            void persist().catch(() => {});
          }
        })
        .catch(() => {});
    },
  });
  // 选择器关闭后回到设置页，保持面板内容完整
  const mo = new MutationObserver(() => {
    if (!document.querySelector(".overlay")) {
      mo.disconnect();
      renderSettings(box);
    }
  });
  mo.observe(document.body, { childList: true });
}

// ---------------- 挂载 ----------------

export async function mountTaskbarPanel(root: HTMLElement): Promise<void> {
  document.body.classList.add("tb-panel-body");

  const box = document.createElement("div");
  box.className = "tb-panel";
  root.appendChild(box);

  const render = async (mode: string): Promise<void> => {
    if (mode === "picker") {
      await renderPicker(box);
    } else {
      renderSettings(box);
    }
  };

  await render(await invoke<string>("take_panel_mode"));
  void getCurrentWebview()
    .listen<string>("panel-mode", (ev) => void render(ev.payload))
    .catch(() => {});

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") void getCurrentWindow().hide();
  });
}

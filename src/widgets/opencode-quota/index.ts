import { invoke } from "@tauri-apps/api/core";
import { registerWidget } from "../../platform/registry";
import {
  button,
  closeOverlays,
  field,
  modal,
  textInput,
} from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import {
  DEFAULT_INTERVAL,
  buildBarRow,
  buildWidgetShell,
  fetchJson,
  fmtTime,
  loadQuotaConfig,
  type QuotaConfig,
  type UsageWindow,
} from "../quota-shared";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

interface OcData extends QuotaConfig {
  last?: {
    rolling?: UsageWindow;
    weekly?: UsageWindow;
    monthly?: UsageWindow;
    fetchedAt?: number;
    error?: string | null;
  };
}

interface OcUsagePayload {
  usage?: Record<
    string,
    { status?: string; percent?: number; resetsAt?: string } | undefined
  >;
}

function parseWindows(p: unknown): {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
} {
  const out: {
    rolling?: UsageWindow;
    weekly?: UsageWindow;
    monthly?: UsageWindow;
  } = {};
  try {
    const u = (p as OcUsagePayload).usage ?? {};
    const grab = (k: string): UsageWindow | undefined => {
      const w = u[k];
      if (!w || typeof w.percent !== "number") return undefined;
      return {
        percent: w.percent,
        resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
      };
    };
    out.rolling = grab("rolling");
    out.weekly = grab("weekly");
    out.monthly = grab("monthly");
  } catch {
    /* ignore */
  }
  return out;
}

const data: OcData = { apiKey: "", intervalMin: DEFAULT_INTERVAL };

let bars: ReturnType<typeof buildBarRow>[] = [];
let footer: HTMLDivElement | null = null;
let btnRefresh: HTMLButtonElement | null = null;
let alive = false;

async function resolveToken(): Promise<string> {
  if (data.apiKey.trim()) return data.apiKey.trim();
  try {
    return await invoke<string>("resolve_opencode_key");
  } catch {
    return "";
  }
}

async function refresh(): Promise<void> {
  if (!alive || !footer) return;
  btnRefresh?.classList.add("spin");
  try {
    const token = await resolveToken();
    if (!token) throw new Error("未配置 API Key（可自动读取本机 opencode 登录）");
    const p = await fetchJson(USAGE_URL, token);
    const w = parseWindows(p);
    data.last = { ...w, fetchedAt: Date.now(), error: null };
    applyBars();
  } catch (e) {
    const msg = String(e);
    let friendly = msg;
    if (msg.includes("401")) friendly = "API Key 无效（401）";
    else if (msg.includes("403")) friendly = "该 Key 未订阅 OpenCode Go（403）";
    data.last = { ...(data.last ?? {}), error: friendly };
    if (footer) {
      footer.textContent = friendly;
      footer.classList.add("err");
    }
  } finally {
    btnRefresh?.classList.remove("spin");
    void widgetSave("opencode-quota", structuredClone(data));
  }
}

function applyBars(): void {
  if (!alive) return;
  const l = data.last;
  if (bars[0])
    bars[0].setUsage(
      l?.error ? null : (l?.rolling ?? null),
      l && !l.error ? "--" : undefined,
    );
  if (bars[1]) bars[1].setUsage(l?.weekly ?? null);
  if (bars[2]) bars[2].setUsage(l?.monthly ?? null);
  if (footer) {
    footer.classList.remove("err");
    footer.textContent = l?.error
      ? String(l.error)
      : `更新于 ${l?.fetchedAt ? fmtTime(new Date(l.fetchedAt)) : "--"} · 每 ${data.intervalMin} 分钟自动刷新`;
  }
}

function openSettings(): void {
  closeOverlays();
  const keyInput = textInput(data.apiKey, "留空则自动读取本机 opencode 登录");
  const intervalSel = document.createElement("select");
  for (const m of [1, 2, 5, 10, 30, 60]) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = `${m} 分钟`;
    opt.selected = m === data.intervalMin;
    intervalSel.appendChild(opt);
  }

  modal(
    "OpenCode Go 设置",
    [
      field("API Key（sk-…）", keyInput),
      field("自动刷新间隔", intervalSel),
    ],
    [
      button("取消", "", () => closeOverlays()),
      button(
        "保存",
        "primary",
        () => {
          data.apiKey = keyInput.value.trim();
          data.intervalMin = parseInt(intervalSel.value, 10) || DEFAULT_INTERVAL;
          void widgetSave("opencode-quota", structuredClone(data));
          closeOverlays();
          void refresh();
        },
      ),
    ],
  );
}

async function mountOcQuota(root: HTMLElement): Promise<() => void> {
  alive = true;
  Object.assign(data, await loadQuotaConfig<OcData>("opencode-quota", data));

  const shell = buildWidgetShell(root, "🟠", "OpenCode Go 额度");
  footer = shell.footer;
  btnRefresh = shell.btnRefresh;

  const rolling = buildBarRow("5 小时滚动");
  const weekly = buildBarRow("本周");
  const monthly = buildBarRow("本月");
  bars = [rolling, weekly, monthly];
  for (const b of bars) shell.body.appendChild(b.root);

  applyBars();
  shell.btnGear.onclick = () => openSettings();
  shell.btnRefresh.onclick = () => void refresh();

  const timer = window.setInterval(() => {
    const due =
      !data.last?.fetchedAt ||
      Date.now() - data.last.fetchedAt > data.intervalMin * 60_000;
    if (due) void refresh();
  }, 30_000);
  void refresh();

  return () => {
    alive = false;
    window.clearInterval(timer);
    bars = [];
    footer = null;
  };
}

registerWidget({
  id: "opencode-quota",
  name: "OpenCode Go 额度",
  icon: "🟠",
  color: "#ff9f43",
  desc: "监控 OpenCode Go 三窗口用量",
  width: 300,
  height: 330,
  minWidth: 240,
  minHeight: 200,
  mount: (root) => mountOcQuota(root),
  summary: async () => {
    const saved = await widgetLoad<Partial<OcData>>("opencode-quota", {});
    const l = saved.last;
    if (!l) return "点击配置或自动读取登录";
    if (l.error) return String(l.error);
    return `5h ${Math.round(l.rolling?.percent ?? 0)}% · 周 ${Math.round(
      l.weekly?.percent ?? 0,
    )}%`;
  },
});

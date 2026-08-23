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
  buildWidgetShell,
  fetchJson,
  loadQuotaConfig,
  type QuotaConfig,
} from "../quota-shared";

const BALANCE_URL = "https://api.deepseek.com/user/balance";

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface DsPayload {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

interface DsData extends QuotaConfig {
  last?: {
    total?: string;
    currency?: string;
    available?: boolean;
    usageDay?: number;
    usageMonth?: number;
    fetchedAt?: number;
    error?: string | null;
  };
  /** 今日用量追踪：基线 = 当日首次观察到的余额 */
  day?: { date: string; base: number };
  /** 本月用量追踪：基线 = 当月首次观察到的余额 */
  month?: { month: string; base: number };
}

function localDateStr(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 更新日/月用量基线；余额上涨视为充值，同步抬高基线避免误计为负消耗 */
function trackUsage(total: number): { usageDay: number; usageMonth: number } {
  const dstr = localDateStr();
  const mstr = dstr.slice(0, 7);

  if (!data.day || data.day.date !== dstr) {
    data.day = { date: dstr, base: total };
  } else if (total > data.day.base) {
    data.day.base = total;
  }
  if (!data.month || data.month.month !== mstr) {
    data.month = { month: mstr, base: total };
  } else if (total > data.month.base) {
    data.month.base = total;
  }

  return {
    usageDay: Math.max(0, Math.round((data.day.base - total) * 100) / 100),
    usageMonth: Math.max(0, Math.round((data.month.base - total) * 100) / 100),
  };
}

const data: DsData = { apiKey: "", intervalMin: DEFAULT_INTERVAL };

let els: {
  total: HTMLDivElement | null;
  usageDay: HTMLSpanElement | null;
  usageMonth: HTMLSpanElement | null;
  dot: HTMLSpanElement | null;
  statusText: HTMLSpanElement | null;
  footer: HTMLDivElement | null;
} = {
  total: null,
  usageDay: null,
  usageMonth: null,
  dot: null,
  statusText: null,
  footer: null,
};

let btnRefresh: HTMLButtonElement | null = null;
let alive = false;

function applyLast(): void {
  if (!alive) return;
  const l = data.last;
  const sym = l?.currency === "USD" ? "$" : "¥";
  if (els.total) {
    if (l?.error) {
      els.total.textContent = "--";
    } else if (l?.total !== undefined) {
      els.total.textContent = `${sym}${l.total}`;
      els.total.classList.remove("placeholder");
    } else {
      els.total.textContent = "待配置";
      els.total.classList.add("placeholder");
    }
  }
  if (els.usageDay)
    els.usageDay.textContent = `${sym}${(l?.usageDay ?? 0).toFixed(2)}`;
  if (els.usageMonth)
    els.usageMonth.textContent = `${sym}${(l?.usageMonth ?? 0).toFixed(2)}`;

  if (els.dot && els.statusText) {
    if (l?.error) {
      els.dot.className = "ds-dot err";
      els.statusText.textContent = String(l.error);
    } else if (l?.available === true) {
      els.dot.className = "ds-dot ok";
      els.statusText.textContent = "余额可用";
    } else if (l && l.available === false) {
      els.dot.className = "ds-dot warn";
      els.statusText.textContent = "余额不足";
    } else {
      els.dot.className = "ds-dot idle";
      els.statusText.textContent = "未连接";
    }
  }
  if (els.footer) {
    els.footer.classList.toggle("err", !!l?.error);
    els.footer.textContent = l?.error ? String(l.error) : "";
  }
}

async function refresh(): Promise<void> {
  if (!alive) return;
  btnRefresh?.classList.add("spin");
  try {
    const token = data.apiKey.trim();
    if (!token) throw new Error("请先在设置中填写 DeepSeek API Key");
    const p = (await fetchJson(BALANCE_URL, token)) as DsPayload;
    const info = p.balance_infos?.[0];
    const totalNum = parseFloat(info?.total_balance ?? "0") || 0;
    const { usageDay, usageMonth } = trackUsage(totalNum);
    data.last = {
      total: info?.total_balance ?? "-",
      currency: info?.currency ?? "CNY",
      available: p.is_available === true,
      usageDay,
      usageMonth,
      fetchedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    const msg = String(e);
    let friendly = msg;
    if (msg.includes("401")) friendly = "API Key 无效（401）";
    data.last = { ...(data.last ?? {}), error: friendly };
  } finally {
    btnRefresh?.classList.remove("spin");
    applyLast();
    void widgetSave("deepseek-balance", structuredClone(data));
  }
}

function openSettings(): void {
  closeOverlays();
  const keyInput = textInput(data.apiKey, "sk-…");
  const intervalSel = document.createElement("select");
  for (const m of [5, 10, 30, 60]) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = `${m} 分钟`;
    opt.selected = m === data.intervalMin;
    intervalSel.appendChild(opt);
  }

  modal(
    "DeepSeek 设置",
    [field("API Key（sk-…）", keyInput), field("自动刷新间隔", intervalSel)],
    [
      button("取消", "", () => closeOverlays()),
      button(
        "保存",
        "primary",
        () => {
          data.apiKey = keyInput.value.trim();
          data.intervalMin =
            parseInt(intervalSel.value, 10) || DEFAULT_INTERVAL;
          void widgetSave("deepseek-balance", structuredClone(data));
          closeOverlays();
          void refresh();
        },
      ),
    ],
  );
}

async function mountDsBalance(root: HTMLElement): Promise<() => void> {
  alive = true;
  Object.assign(data, await loadQuotaConfig<DsData>("deepseek-balance", data));

  const shell = buildWidgetShell(root, "🐋", "DeepSeek 余额");
  btnRefresh = shell.btnRefresh;

  shell.body.innerHTML = `
    <div class="ds-total-row">
      <div class="ds-total placeholder" id="ds-total">待配置</div>
    </div>
    <div class="ds-rows">
      <span class="ds-chip">今日</span><span class="ds-val" id="ds-day">-</span>
      <span class="ds-gap"></span>
      <span class="ds-chip">本月</span><span class="ds-val" id="ds-month">-</span>
    </div>
    <div class="ds-status">
      <span class="ds-dot idle"></span>
      <span class="ds-status-text">未连接</span>
    </div>
  `;
  els = {
    total: shell.body.querySelector("#ds-total"),
    usageDay: shell.body.querySelector("#ds-day"),
    usageMonth: shell.body.querySelector("#ds-month"),
    dot: shell.body.querySelector(".ds-dot"),
    statusText: shell.body.querySelector(".ds-status-text"),
    footer: shell.footer,
  };
  applyLast();

  shell.btnGear.onclick = () => openSettings();
  shell.btnRefresh.onclick = () => void refresh();

  const timer = window.setInterval(() => {
    const due =
      !data.last?.fetchedAt ||
      Date.now() - data.last.fetchedAt > data.intervalMin * 60_000;
    if (due) void refresh();
  }, 30_000);
  if (data.apiKey.trim()) void refresh();

  return () => {
    alive = false;
    window.clearInterval(timer);
    els = {
      total: null,
      usageDay: null,
      usageMonth: null,
      dot: null,
      statusText: null,
      footer: null,
    };
  };
}

registerWidget({
  id: "deepseek-balance",
  name: "DeepSeek 余额",
  icon: "🐋",
  color: "#4d6bfe",
  desc: "监控 DeepSeek 余额与今日/本月用量",
  width: 300,
  height: 250,
  minWidth: 240,
  minHeight: 180,
  mount: (root) => mountDsBalance(root),
  summary: async () => {
    const saved = await widgetLoad<Partial<DsData>>("deepseek-balance", {});
    const l = saved.last;
    if (!l || l.error) return "点击配置 API Key";
    const sym = l.currency === "USD" ? "$" : "¥";
    return `${sym}${l.total ?? "-"} · 今日 ${sym}${(l.usageDay ?? 0).toFixed(2)}`;
  },
});

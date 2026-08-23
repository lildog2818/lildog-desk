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
  fmtTime,
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
    granted?: string;
    toppedUp?: string;
    currency?: string;
    available?: boolean;
    fetchedAt?: number;
    error?: string | null;
  };
}

const data: DsData = { apiKey: "", intervalMin: DEFAULT_INTERVAL };

let els: {
  total: HTMLDivElement | null;
  granted: HTMLSpanElement | null;
  toppedUp: HTMLSpanElement | null;
  dot: HTMLSpanElement | null;
  statusText: HTMLSpanElement | null;
  footer: HTMLDivElement | null;
} = {
  total: null,
  granted: null,
  toppedUp: null,
  dot: null,
  statusText: null,
  footer: null,
};

let btnRefresh: HTMLButtonElement | null = null;
let alive = false;

function applyLast(): void {
  if (!alive) return;
  const l = data.last;
  if (els.total) {
    if (l?.error) {
      els.total.textContent = "--";
    } else if (l?.total !== undefined) {
      const cur = l.currency ?? "";
      els.total.textContent = `${cur === "CNY" ? "¥" : cur === "USD" ? "$" : ""}${l.total}`;
      els.total.classList.remove("placeholder");
    } else {
      els.total.textContent = "待配置";
      els.total.classList.add("placeholder");
    }
  }
  if (els.granted) els.granted.textContent = `赠金 ¥${l?.granted ?? "-"}`;
  if (els.toppedUp)
    els.toppedUp.textContent = `充值 ${l?.currency === "USD" ? "$" : "¥"}${l?.toppedUp ?? "-"}`;

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
    els.footer.classList.remove("err");
    els.footer.textContent = l?.error
      ? ""
      : `更新于 ${l?.fetchedAt ? fmtTime(new Date(l.fetchedAt)) : "--"} · 每 ${data.intervalMin} 分钟自动刷新`;
    if (l?.error) {
      els.footer.textContent = String(l.error);
      els.footer.classList.add("err");
    }
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
    data.last = {
      total: info?.total_balance ?? "-",
      granted: info?.granted_balance ?? "-",
      toppedUp: info?.topped_up_balance ?? "-",
      currency: info?.currency ?? "CNY",
      available: p.is_available === true,
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
      <span class="ds-chip">赠金</span><span class="ds-val" id="ds-granted">-</span>
      <span class="ds-gap"></span>
      <span class="ds-chip">充值</span><span class="ds-val" id="ds-topped">-</span>
    </div>
    <div class="ds-status">
      <span class="ds-dot idle"></span>
      <span class="ds-status-text">未连接</span>
    </div>
  `;
  els = {
    total: shell.body.querySelector("#ds-total"),
    granted: shell.body.querySelector("#ds-granted"),
    toppedUp: shell.body.querySelector("#ds-topped"),
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
      granted: null,
      toppedUp: null,
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
  desc: "监控 DeepSeek API 账户余额",
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
    return `${sym}${l.total ?? "-"} · ${l.available ? "可用" : "余额不足"}`;
  },
});

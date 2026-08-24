import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { registerWidget } from "../../platform/registry";
import { buildMenu, closeMenus, confirmDanger, toast } from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/clipboard.css";

type ClipKind = "text" | "image" | "files";

interface ClipItem {
  id: string;
  kind: ClipKind;
  text?: string;
  truncated?: boolean;
  imagePath?: string;
  width?: number;
  height?: number;
  files?: string[];
  pinned: boolean;
  ts: number;
}

interface ClipData {
  items: ClipItem[];
  maxItems: number;
}

/** 与 Rust ClipPayload(camelCase) 对应 */
interface ClipPayload {
  seq: number;
  kind: "text" | "image" | "files" | "other";
  text?: string;
  truncated?: boolean;
  imagePath?: string;
  width?: number;
  height?: number;
  files?: string[];
}

type Tab = "all" | ClipKind;

const DEFAULT_MAX = 200;
const ABSOLUTE_CAP = 800;
const POLL_INTERVAL_MS = 600;

let data: ClipData = { items: [], maxItems: DEFAULT_MAX };
let lastSeq = 0;
let saveTimer = 0;
let pollTimer = 0;
let tab: Tab = "all";
let query = "";

function uid(): string {
  return crypto.randomUUID();
}

function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("clipboard", structuredClone(data));
  }, 250);
}

function sameList(a?: string[], b?: string[]): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${hm}`;
}

// ---------------- 入库 ----------------

function trim(): void {
  // 超出上限时从最旧的非置顶条目开始淘汰
  while (data.items.length > data.maxItems) {
    let idx = -1;
    for (let i = data.items.length - 1; i >= 0; i -= 1) {
      if (!data.items[i].pinned) {
        idx = i;
        break;
      }
    }
    if (idx < 0) break; // 全是置顶项，交给绝对上限兜底
    removeImageFile(data.items[idx]);
    data.items.splice(idx, 1);
  }
  // 绝对上限（含置顶）防止无限膨胀
  while (data.items.length > ABSOLUTE_CAP) {
    removeImageFile(data.items[data.items.length - 1]);
    data.items.pop();
  }
}

function removeImageFile(item: ClipItem): void {
  if (item.kind === "image" && item.imagePath) {
    void invoke("delete_clipboard_image", { path: item.imagePath }).catch(
      () => {},
    );
  }
}

function ingest(p: ClipPayload): void {
  if (p.kind === "other") return;

  if (p.kind === "text") {
    const text = p.text ?? "";
    if (!text.trim()) return;
    const top = data.items.find((i) => i.kind === "text");
    if (top && top.text === text) return; // 与最新文本相同：忽略
    data.items.unshift({
      id: uid(),
      kind: "text",
      text,
      truncated: !!p.truncated,
      pinned: false,
      ts: Date.now(),
    });
  } else if (p.kind === "image") {
    if (!p.imagePath) return;
    data.items.unshift({
      id: uid(),
      kind: "image",
      imagePath: p.imagePath,
      width: p.width,
      height: p.height,
      pinned: false,
      ts: Date.now(),
    });
  } else {
    const files = p.files ?? [];
    if (files.length === 0) return;
    const top = data.items.find((i) => i.kind === "files");
    if (top && sameList(top.files, files)) return;
    data.items.unshift({
      id: uid(),
      kind: "files",
      files,
      pinned: false,
      ts: Date.now(),
    });
  }
  trim();
  persist();
  render();
}

async function poll(): Promise<void> {
  try {
    const p = await invoke<ClipPayload | null>("read_clipboard_state", {
      lastSeq,
    });
    if (!p) return;
    lastSeq = p.seq;
    ingest(p);
  } catch {
    /* 打不开剪贴板等情况下一轮重试 */
  }
}

// ---------------- 操作 ----------------

async function copyItem(item: ClipItem): Promise<void> {
  try {
    if (item.kind === "text") {
      lastSeq = await invoke<number>("write_clipboard_text", {
        text: item.text ?? "",
      });
    } else if (item.kind === "files") {
      lastSeq = await invoke<number>("write_clipboard_files", {
        paths: item.files ?? [],
      });
    } else {
      toast("图片回填将在后续版本支持");
      return;
    }
    toast("已复制到剪贴板");
  } catch (e) {
    toast(String(e));
  }
}

function deleteItem(item: ClipItem): void {
  removeImageFile(item);
  data.items = data.items.filter((i) => i.id !== item.id);
  persist();
  render();
}

// ---------------- 渲染 ----------------

function rowEl(item: ClipItem): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cb-row";

  const icon = document.createElement("div");
  icon.className = "cb-row-icon";
  if (item.kind === "image" && item.imagePath) {
    const img = document.createElement("img");
    img.src = convertFileSrc(item.imagePath);
    img.draggable = false;
    icon.appendChild(img);
  } else {
    icon.textContent = item.kind === "files" ? "📁" : "📄";
  }

  const main = document.createElement("div");
  main.className = "cb-main";
  const preview = document.createElement("div");
  preview.className = "cb-preview";
  const sub = document.createElement("div");
  sub.className = "cb-sub";
  if (item.kind === "text") {
    preview.textContent = `${item.pinned ? "📌 " : ""}${firstLine(item.text ?? "")}`;
    sub.textContent = `${(item.text ?? "").length} 字符${item.truncated ? " · 已截断" : ""}`;
  } else if (item.kind === "image") {
    preview.textContent = `${item.pinned ? "📌 " : ""}图片 ${item.width ?? "?"}×${item.height ?? "?"}`;
    sub.textContent = item.imagePath?.split(/[\\/]/).pop() ?? "";
  } else {
    const names = item.files ?? [];
    preview.textContent = `${item.pinned ? "📌 " : ""}${names[0] ?? ""}${names.length > 1 ? ` 等 ${names.length} 项` : ""}`;
    sub.textContent = names.slice(1, 3).join("、");
  }
  main.append(preview, sub);

  const time = document.createElement("div");
  time.className = "cb-time";
  time.textContent = fmtTime(item.ts);

  row.append(icon, main, time);
  row.onclick = () => void copyItem(item);
  row.oncontextmenu = (ev) => {
    ev.preventDefault();
    buildMenu(ev.clientX, ev.clientY, [
      { label: "复制", action: () => void copyItem(item) },
      {
        label: item.pinned ? "取消置顶" : "置顶",
        action: () => {
          item.pinned = !item.pinned;
          persist();
          render();
        },
      },
      {
        label: "删除",
        danger: true,
        action: () => deleteItem(item),
      },
    ]);
  };
  return row;
}

function visibleItems(): ClipItem[] {
  const q = query.trim().toLowerCase();
  const pinned: ClipItem[] = [];
  const rest: ClipItem[] = [];
  for (const it of data.items) {
    if (tab !== "all" && it.kind !== tab) continue;
    if (q) {
      // 图片无名称可搜；图片页签下直接显示全部图片
      if (tab === "all" && it.kind === "image") continue;
      if (
        tab !== "image" &&
        !(
          (it.kind === "text" &&
            (it.text ?? "").toLowerCase().includes(q)) ||
          (it.kind === "files" &&
            (it.files ?? []).some((f) => f.toLowerCase().includes(q)))
        )
      ) {
        continue;
      }
    }
    (it.pinned ? pinned : rest).push(it);
  }
  return [...pinned, ...rest];
}

function render(): void {
  closeMenus();
  const list = document.querySelector<HTMLElement>(".cb-list");
  if (!list) return;
  list.innerHTML = "";
  const shown = visibleItems();
  for (const item of shown) list.appendChild(rowEl(item));

  if (shown.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    const dog = document.createElement("span");
    dog.className = "dog";
    dog.textContent = "📋";
    hint.appendChild(dog);
    hint.appendChild(
      document.createTextNode(
        query.trim() || tab !== "all" ? "没有匹配的记录" : "去任意应用复制点什么吧",
      ),
    );
    list.appendChild(hint);
  }

  const footer = document.querySelector<HTMLElement>(".qw-footer");
  if (footer) footer.textContent = `${data.items.length} 条记录 · 上限 ${data.maxItems}`;
}

// ---------------- 挂载 ----------------

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "text", label: "文字" },
  { key: "image", label: "图片" },
  { key: "files", label: "文件" },
];

function mountClipboard(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "📋", "剪贴板");
  shell.btnRefresh.remove();

  const toolbar = document.createElement("div");
  toolbar.className = "cb-toolbar";

  const tabsBox = document.createElement("div");
  tabsBox.className = "cb-tabs";
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const t of TABS) {
    const b = document.createElement("button");
    b.className = `cb-tab${t.key === tab ? " on" : ""}`;
    b.textContent = t.label;
    b.onclick = () => {
      tab = t.key;
      tabsBox
        .querySelectorAll(".cb-tab")
        .forEach((el) => el.classList.remove("on"));
      b.classList.add("on");
      render();
    };
    tabBtns.set(t.key, b);
    tabsBox.appendChild(b);
  }

  const search = document.createElement("input");
  search.className = "cb-search";
  search.placeholder = "搜索剪贴内容…";
  search.spellcheck = false;
  search.oninput = () => {
    query = search.value;
    render();
  };

  toolbar.append(tabsBox, search);

  const list = document.createElement("div");
  list.className = "cb-list";
  shell.body.classList.add("cb-body");
  shell.body.append(toolbar, list);

  // 设置菜单：条数上限 + 清空全部
  shell.btnGear.onclick = (ev) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    buildMenu(rect.left, rect.bottom + 6, [
      {
        label: `条数上限（当前 ${data.maxItems}）`,
        sub: [100, 200, 500].map((n) => ({
          label: String(n),
          action: () => {
            data.maxItems = n;
            trim();
            persist();
            render();
          },
        })),
      },
      { label: undefined, action: undefined },
      {
        label: "清空全部",
        danger: true,
        action: () =>
          confirmDanger(
            `将删除全部 ${data.items.length} 条记录，对应图片文件同步移除。`,
            () => {
              for (const it of [...data.items]) removeImageFile(it);
              data.items = [];
              persist();
              render();
            },
          ),
      },
    ]);
  };

  void widgetLoad<Partial<ClipData>>("clipboard", {}).then((d) => {
    const items = Array.isArray(d.items)
      ? d.items.filter(
          (i): i is ClipItem =>
            typeof i?.id === "string" &&
            (i.kind === "text" || i.kind === "image" || i.kind === "files"),
        )
      : [];
    data = {
      items,
      maxItems:
        typeof d.maxItems === "number"
          ? Math.min(1000, Math.max(50, Math.round(d.maxItems)))
          : DEFAULT_MAX,
    };
    render();
  });

  render();

  pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  void poll();

  return () => {
    window.clearInterval(pollTimer);
    window.clearTimeout(saveTimer);
  };
}

registerWidget({
  id: "clipboard",
  name: "剪贴板",
  icon: "📋",
  color: "#60a5fa",
  desc: "自动记录复制的文字、图片与文件，单击回填",
  width: 320,
  height: 480,
  minWidth: 260,
  minHeight: 180,
  mount: (root) => mountClipboard(root),
  summary: async () => {
    const d = await widgetLoad<Partial<ClipData>>("clipboard", {});
    const n = Array.isArray(d.items) ? d.items.length : 0;
    return n > 0 ? `${n} 条剪贴记录` : "暂无剪贴记录";
  },
});

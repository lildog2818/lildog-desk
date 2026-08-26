import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { registerWidget } from "../../platform/registry";
import {
  buildMenu,
  closeMenus,
  confirmDanger,
  toast,
  type MenuEntry,
} from "../../platform/shell";
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

/** 页签：null 表示不筛选（混合视图），无「全部」按钮 */
type Tab = ClipKind | null;

let data: ClipData = { items: [] };
let lastSeq = 0;
let saveTimer = 0;
let pollTimer = 0;
let tab: Tab = "text"; // 默认停留在文字页签，图片/文件按需切换
let query = "";
/** 键盘导航高亮的行 id */
let selectedId: string | null = null;

/** 缩略图 data-url 缓存 */
const thumbCache = new Map<string, string>();

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

function removeImageFile(item: ClipItem): void {
  if (item.kind === "image" && item.imagePath) {
    thumbCache.delete(item.imagePath);
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

/** 把条目写回系统剪贴板；返回是否成功 */
async function writeToClipboard(item: ClipItem): Promise<boolean> {
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
      lastSeq = await invoke<number>("write_clipboard_image", {
        path: item.imagePath ?? "",
      });
    }
    return true;
  } catch (e) {
    toast(String(e));
    return false;
  }
}

/** 单击：复制到剪贴板 */
function copyItem(item: ClipItem): void {
  void writeToClipboard(item).then((ok) => {
    if (ok) toast("已复制到剪贴板");
  });
}

/** 双击 / Enter：粘贴回热键呼出前的窗口 */
function pasteItem(item: ClipItem): void {
  void writeToClipboard(item).then(async (ok) => {
    if (!ok) return;
    try {
      await invoke("paste_to_last_target");
    } catch (e) {
      toast(String(e));
    }
  });
}

/** 图片贴图：弹出置顶可拖动缩放的预览窗 */
function pinImage(item: ClipItem): void {
  if (item.kind !== "image" || !item.imagePath) return;
  void invoke("open_image_pin", {
    path: item.imagePath,
    w: item.width ?? 400,
    h: item.height ?? 300,
  }).catch((e) => toast(String(e)));
}

function deleteItem(item: ClipItem): void {
  removeImageFile(item);
  data.items = data.items.filter((i) => i.id !== item.id);
  persist();
  render();
}

// ---------------- 渲染 ----------------

function setThumbImg(box: HTMLElement, url: string): void {
  box.textContent = "";
  const img = document.createElement("img");
  img.src = url;
  img.draggable = false;
  box.appendChild(img);
}

/** 按最长边缩放加载 data-url 缩略图；缓存键含边长 */
function loadThumb(path: string, maxEdge: number, box: HTMLElement): void {
  const key = `${path}@${maxEdge}`;
  const cached = thumbCache.get(key);
  if (cached) {
    setThumbImg(box, cached);
    return;
  }
  void invoke<string>("clip_image_data_url", { path, maxEdge })
    .then((url) => {
      thumbCache.set(key, url);
      if (box.isConnected) setThumbImg(box, url);
    })
    .catch(() => {});
}

function rowEl(item: ClipItem): HTMLDivElement {
  const row = document.createElement("div");
  row.className =
    "cb-row" + (item.id === selectedId ? " sel" : "");
  row.dataset.id = item.id;

  const icon = document.createElement("div");
  icon.className = "cb-row-icon";
  if (item.kind === "image") {
    // 缩略图：保持原始宽高比，不裁切
    icon.classList.add("is-img");
    if (item.imagePath) {
      const cached = thumbCache.get(`${item.imagePath}@96`);
      if (cached) {
        setThumbImg(icon, cached);
      } else {
        loadThumb(item.imagePath, 96, icon);
      }
    }
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
  row.onclick = () => copyItem(item);
  row.ondblclick = () => pasteItem(item);
  row.oncontextmenu = (ev) => {
    ev.preventDefault();
    selectedId = item.id;
    render();
    buildMenu(ev.clientX, ev.clientY, itemMenuEntries(item));
  };
  return row;
}

/** 行 / 网格共用的右键菜单 */
function itemMenuEntries(item: ClipItem): MenuEntry[] {
  return [
    { label: "复制", action: () => copyItem(item) },
    ...(item.kind === "image"
      ? [{ label: "贴图", action: () => pinImage(item) }]
      : []),
    { label: "粘贴到原窗口", action: () => pasteItem(item) },
    {
      label: item.pinned ? "取消置顶" : "置顶",
      action: () => {
        item.pinned = !item.pinned;
        persist();
        render();
      },
    },
    { label: undefined, action: undefined },
    { label: "删除", danger: true, action: () => deleteItem(item) },
  ];
}

/** 图片页签的缩略图网格单元：完整显示原始宽高比（参考 WPF 版样式） */
function cellEl(item: ClipItem): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "cb-cell";

  const box = document.createElement("div");
  box.className = "cb-cell-img";
  if (item.imagePath) {
    const key = `${item.imagePath}@320`;
    const cached = thumbCache.get(key);
    if (cached) setThumbImg(box, cached);
    else loadThumb(item.imagePath, 320, box);
  }
  cell.appendChild(box);

  if (item.pinned) {
    const badge = document.createElement("span");
    badge.className = "cb-cell-badge";
    badge.textContent = "📌";
    cell.appendChild(badge);
  }

  const cap = document.createElement("div");
  cap.className = "cb-cell-cap";
  cap.textContent = `${item.width ?? "?"}×${item.height ?? "?"} · ${fmtTime(item.ts)}`;
  cell.appendChild(cap);

  cell.title = `单击复制 · 双击粘贴 · ${fmtTime(item.ts)}`;
  cell.onclick = () => copyItem(item);
  cell.ondblclick = () => pasteItem(item);
  cell.oncontextmenu = (ev) => {
    ev.preventDefault();
    selectedId = item.id;
    buildMenu(ev.clientX, ev.clientY, itemMenuEntries(item));
  };
  return cell;
}

function visibleItems(): ClipItem[] {
  const q = query.trim().toLowerCase();
  const pinned: ClipItem[] = [];
  const rest: ClipItem[] = [];
  for (const it of data.items) {
    if (tab !== null && it.kind !== tab) continue;
    if (q) {
      // 混合视图下图片不参与文本搜索；图片页签下显示全部图片
      if (tab === null && it.kind === "image") continue;
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

  // 图片页签：自适应缩略图网格（保持原始宽高比）
  if (tab === "image" && shown.length > 0) {
    list.classList.add("cb-gridmode");
    const grid = document.createElement("div");
    grid.className = "cb-grid";
    for (const item of shown) grid.appendChild(cellEl(item));
    list.appendChild(grid);
  } else {
    list.classList.remove("cb-gridmode");
    for (const item of shown) list.appendChild(rowEl(item));
  }

  if (shown.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    const dog = document.createElement("span");
    dog.className = "dog";
    dog.textContent = "📋";
    hint.appendChild(dog);
    hint.appendChild(
      document.createTextNode(
        query.trim() || tab !== null ? "没有匹配的记录" : "去任意应用复制点什么吧",
      ),
    );
    list.appendChild(hint);
  }

  const footer = document.querySelector<HTMLElement>(".qw-footer");
  if (footer) footer.textContent = `${data.items.length} 条记录`;
}

// ---------------- 挂载 ----------------

const TABS: Array<{ key: Exclude<Tab, null>; label: string }> = [
  { key: "text", label: "文字" },
  { key: "image", label: "图片" },
  { key: "files", label: "文件" },
];

function paintTabs(tabsBox: HTMLElement): void {
  tabsBox.querySelectorAll<HTMLElement>(".cb-tab").forEach((el) => {
    el.classList.toggle("on", el.dataset.key === tab);
  });
}

function mountClipboard(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "📋", "剪贴板");
  shell.btnRefresh.remove();

  const toolbar = document.createElement("div");
  toolbar.className = "cb-toolbar";

  const tabsBox = document.createElement("div");
  tabsBox.className = "cb-tabs";
  for (const t of TABS) {
    const b = document.createElement("button");
    b.className = "cb-tab";
    b.dataset.key = t.key;
    b.textContent = t.label;
    b.title = "再次点击取消筛选";
    b.onclick = () => {
      tab = tab === t.key ? null : t.key;
      selectedId = null;
      paintTabs(tabsBox);
      render();
    };
    tabsBox.appendChild(b);
  }

  const search = document.createElement("input");
  search.className = "cb-search";
  search.placeholder = "搜索剪贴内容…";
  search.spellcheck = false;
  search.oninput = () => {
    query = search.value;
    selectedId = null;
    render();
  };

  toolbar.append(tabsBox, search);

  const list = document.createElement("div");
  list.className = "cb-list";
  list.tabIndex = 0;
  shell.body.classList.add("cb-body");
  shell.body.append(toolbar, list);

  // 键盘导航：↑↓ 选择、Enter 粘贴高亮项
  list.addEventListener("keydown", (ev) => {
    const shown = visibleItems();
    if (shown.length === 0) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const idx = shown.findIndex((i) => i.id === selectedId);
      const next =
        ev.key === "ArrowDown"
          ? Math.min(shown.length - 1, idx + 1)
          : idx <= 0
            ? 0
            : idx - 1;
      selectedId = shown[Math.max(0, next)].id;
      render();
      root
        .querySelector<HTMLElement>(`.cb-row[data-id="${selectedId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const target =
        shown.find((i) => i.id === selectedId) ?? shown[0];
      if (target) pasteItem(target);
    }
  });

  // 设置菜单：保存位置 + 清空全部
  shell.btnGear.onclick = (ev) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    buildMenu(rect.left, rect.bottom + 6, [
      {
        label: "保存位置…",
        action: () => {
          void openFileDialog({ directory: true, multiple: false })
            .then((picked) => {
              const dir = Array.isArray(picked) ? picked[0] : picked;
              if (!dir) return;
              return invoke("set_clip_dir", { path: dir }).then(() => {
                thumbCache.clear();
                render();
                toast("已切换保存位置");
              });
            })
            .catch((e) => toast(String(e)));
        },
      },
      {
        label: "恢复默认位置",
        action: () => {
          void invoke("set_clip_dir", { path: null })
            .then(() => {
              thumbCache.clear();
              render();
              toast("已恢复默认位置");
            })
            .catch((e) => toast(String(e)));
        },
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
    data = { items }; // 不设条数上限；旧的 maxItems 字段忽略
    render();
  });

  render();

  pollTimer = window.setInterval(() => void poll(), 600);
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
  desc: "自动记录复制的文字、图片与文件，单击回填、双击粘贴",
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

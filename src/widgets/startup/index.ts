import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  addStartupItem,
  listStartupItems,
  removeStartupItem,
  STARTUP_LOCATION_LABEL,
  startupEdit,
  startupIconSources,
  startupRestore,
  type StartupItem,
} from "../../platform/startup";
import { registerWidget } from "../../platform/registry";
import {
  buildMenu,
  button,
  closeMenus,
  closeOverlays,
  confirmDanger,
  field,
  modal,
  textInput,
  toast,
  type MenuEntry,
} from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/startup.css";

const LOCATION_ICON: Record<string, string> = {
  "hkcu-run": "👤",
  "hklm-run": "🛡️",
  "user-startup": "📁",
  "common-startup": "🗂️",
};

const BADGE_CLASS: Record<string, string> = {
  "hkcu-run": "hkcu",
  "hklm-run": "hklm",
  "user-startup": "folder",
  "common-startup": "folder",
};

const FOLDER_LOCATIONS = new Set(["user-startup", "common-startup"]);

interface DisabledItem {
  location: string;
  key: string;
  name: string;
  command: string;
}

let items: StartupItem[] = [];
let disabled: DisabledItem[] = [];
let loading = false;
let filterText = "";
const iconCache = new Map<string, string>();
const iconFailed = new Set<string>();
let saveTimer = 0;

function locationLabel(loc: string): string {
  return STARTUP_LOCATION_LABEL[loc] ?? loc;
}

function persistDisabled(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("startup", { disabled });
  }, 250);
}

function shortLocation(loc: string): string {
  switch (loc) {
    case "hkcu-run": return "HKCU";
    case "hklm-run": return "HKLM";
    case "user-startup": return "启动文件夹";
    case "common-startup": return "公共启动";
    default: return loc;
  }
}

function fallbackEmoji(loc: string): string {
  return LOCATION_ICON[loc] ?? "⚙️";
}

function setIconImg(box: HTMLElement, path: string): void {
  box.textContent = "";
  const img = document.createElement("img");
  img.src = convertFileSrc(path);
  img.draggable = false;
  box.appendChild(img);
}

async function paintIconsBatch(pairs: Array<{ source: string; box: HTMLElement }>): Promise<void> {
  const need: string[] = [];
  const needBoxes = new Map<string, HTMLElement[]>();
  for (const { source, box } of pairs) {
    if (!source) {
      box.textContent = "⚙️";
      continue;
    }
    const cached = iconCache.get(source);
    if (cached) {
      setIconImg(box, cached);
      continue;
    }
    if (iconFailed.has(source)) {
      box.textContent = "⚙️";
      continue;
    }
    need.push(source);
    const arr = needBoxes.get(source) ?? [];
    arr.push(box);
    needBoxes.set(source, arr);
  }
  if (need.length === 0) return;
  // 去重后的源列表按顺序请求，避免并发风暴；逐个缓存
  const uniq = [...new Set(need)];
  for (const src of uniq) {
    if (iconFailed.has(src) || iconCache.has(src)) continue;
    try {
      const p = await invoke<string>("get_icon", { path: src });
      if (p) {
        iconCache.set(src, p);
        for (const b of needBoxes.get(src) ?? []) if (b.isConnected) setIconImg(b, p);
      } else {
        iconFailed.add(src);
        for (const b of needBoxes.get(src) ?? []) if (b.isConnected) b.textContent = fallbackEmoji("hkcu-run");
      }
    } catch {
      iconFailed.add(src);
      for (const b of needBoxes.get(src) ?? []) if (b.isConnected) b.textContent = fallbackEmoji("hkcu-run");
    }
  }
}

function promptCommand(
  title: string,
  initial: string,
  commit: (v: string) => void,
): void {
  const input = textInput(initial, "程序或命令路径…");
  const ok = () => {
    const v = input.value.trim();
    if (!v) return;
    closeOverlays();
    commit(v);
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") ok();
  };
  modal(title, [field("命令", input)], [
    button("取消", "", () => closeOverlays()),
    button("确定", "primary", ok),
  ]);
}

async function load(render: () => void): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    items = await listStartupItems();
  } catch (e) {
    toast(String(e));
  } finally {
    loading = false;
    const liveKeys = new Set(items.map((i) => `${i.location}:${i.key}`));
    const filtered = disabled.filter((d) => !liveKeys.has(`${d.location}:${d.key}`));
    if (filtered.length !== disabled.length) {
      disabled = filtered;
      persistDisabled();
    }
    render();
  }
}

// ---------------- 菜单动作 ----------------

function editTarget(item: StartupItem, render: () => void): void {
  promptCommand(`修改「${item.name || item.key}」的指向`, item.command, (value) => {
    void startupEdit(item.location, item.key, value)
      .then(() => {
        toast("已修改指向");
        return load(render);
      })
      .catch((e) => toast(String(e)));
  });
}

function copyCommand(command: string): void {
  void navigator.clipboard.writeText(command).then(() => toast("已复制命令")).catch(() => toast("复制失败"));
}

function revealItem(item: StartupItem): void {
  // 文件夹项直接定位文件；注册表项取解析后的 exe 路径
  const guess = item.command;
  void invoke<string>("startup_target_path", { command: guess })
    .then((p) => p || guess)
    .then((p) => {
      if (!p) { toast("未找到目标路径"); return; }
      void invoke("reveal_target", { target: p }).catch((e) => toast(String(e)));
    });
}

function disableItem(item: StartupItem, render: () => void): void {
  confirmDanger(
    `将取消「${item.name || item.key}」的开机自启（${locationLabel(item.location)}），并保留恢复入口，确定？`,
    () => {
      void (async () => {
        let command = item.command;
        if (FOLDER_LOCATIONS.has(item.location) && command.toLowerCase().endsWith(".lnk")) {
          command = await invoke<string>("startup_lnk_command", { path: command }).catch(() => command);
        }
        await removeStartupItem(item.location, item.key);
        disabled.push({ location: item.location, key: item.key, name: item.name, command });
        persistDisabled();
        toast("已关闭开机自启");
        return load(render);
      })().catch((e) => toast(String(e)));
    },
  );
}

function restoreDisabled(d: DisabledItem, render: () => void): void {
  void startupRestore(d.location, d.key, d.name, d.command)
    .then(() => {
      disabled = disabled.filter((x) => !(x.location === d.location && x.key === d.key));
      persistDisabled();
      toast(`已恢复「${d.name}」开机自启`);
      return load(render);
    })
    .catch((e) => toast(String(e)));
}

function deleteItem(item: StartupItem, render: () => void): void {
  confirmDanger(
    `将彻底删除「${item.name || item.key}」的开机启动记录（${locationLabel(item.location)}），且不会保留恢复入口，确定？`,
    () => {
      void removeStartupItem(item.location, item.key)
        .then(() => { toast("已删除该启动项"); return load(render); })
        .catch((e) => toast(String(e)));
    },
  );
}

function dropDisabled(d: DisabledItem): void {
  disabled = disabled.filter((x) => !(x.location === d.location && x.key === d.key));
  persistDisabled();
  toast("已移出列表");
}

// ---------------- 渲染：列表行 ----------------

function itemMenuEntries(item: StartupItem, render: () => void): MenuEntry[] {
  const isFolderFile = FOLDER_LOCATIONS.has(item.location);
  const lnkEditable = !isFolderFile || item.command.toLowerCase().endsWith(".lnk");
  return [
    { label: "修改指向目标…", disabled: !lnkEditable, action: () => editTarget(item, render) },
    { label: "复制命令", action: () => copyCommand(item.command) },
    { label: "打开所在位置", action: () => revealItem(item) },
    { label: undefined, action: undefined },
    { label: "关闭开机自启", action: () => disableItem(item, render) },
    { label: "删除", danger: true, action: () => deleteItem(item, render) },
  ];
}

function disabledMenuEntries(d: DisabledItem, render: () => void): MenuEntry[] {
  return [
    { label: "恢复开机自启", action: () => restoreDisabled(d, render) },
    { label: "复制命令", action: () => copyCommand(d.command) },
    { label: undefined, action: undefined },
    { label: "移出列表", danger: true, action: () => { dropDisabled(d); render(); } },
  ];
}

function rowEl(item: StartupItem, render: () => void, iconBoxHolder: Array<{ source: string; box: HTMLElement }>): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "su-row";
  row.title = `${item.name || item.key}\n${item.command}\n来源：${locationLabel(item.location)}`;

  const icon = document.createElement("div");
  icon.className = "su-icon";
  icon.textContent = fallbackEmoji(item.location);

  const main = document.createElement("div");
  main.className = "su-main";
  const titleRow = document.createElement("div");
  titleRow.className = "su-title-row";
  const nameEl = document.createElement("div");
  nameEl.className = "su-name";
  nameEl.textContent = item.name || item.key;
  const badge = document.createElement("span");
  badge.className = `su-badge ${BADGE_CLASS[item.location] ?? ""}`;
  badge.textContent = shortLocation(item.location);
  titleRow.append(nameEl, badge);

  const cmd = document.createElement("div");
  cmd.className = item.command ? "su-cmd" : "su-cmd empty";
  cmd.textContent = item.command || "（无命令）";
  cmd.title = item.command;

  main.append(titleRow, cmd);

  const actions = document.createElement("div");
  actions.className = "su-actions";
  const btnCopy = document.createElement("button");
  btnCopy.className = "su-act";
  btnCopy.title = "复制命令";
  btnCopy.textContent = "⎘";
  btnCopy.onclick = (e) => { e.stopPropagation(); copyCommand(item.command); };
  const btnReveal = document.createElement("button");
  btnReveal.className = "su-act";
  btnReveal.title = "打开所在位置";
  btnReveal.textContent = "◧";
  btnReveal.onclick = (e) => { e.stopPropagation(); revealItem(item); };
  const btnMore = document.createElement("button");
  btnMore.className = "su-act";
  btnMore.title = "更多";
  btnMore.textContent = "⋯";
  btnMore.onclick = (e) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    buildMenu(r.left, r.bottom + 6, itemMenuEntries(item, render));
  };
  actions.append(btnCopy, btnReveal, btnMore);

  row.append(icon, main, actions);
  row.oncontextmenu = (ev) => {
    ev.preventDefault();
    closeMenus();
    buildMenu(ev.clientX, ev.clientY, itemMenuEntries(item, render));
  };
  row.onclick = () => {
    // 单击行也可快速复制
  };

  // 收集图标待解析：用批量接口一次取 .lnk 目标
  // 先占位，后续批量填充
  iconBoxHolder.push({ source: item.command, box: icon });

  return row;
}

function disabledRowEl(d: DisabledItem, render: () => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "su-row disabled";
  row.title = `${d.name}\n${d.command}\n已停用（来源：${locationLabel(d.location)}）`;
  const icon = document.createElement("div");
  icon.className = "su-icon";
  icon.textContent = "⏸";
  const main = document.createElement("div");
  main.className = "su-main";
  const titleRow = document.createElement("div");
  titleRow.className = "su-title-row";
  const nameEl = document.createElement("div");
  nameEl.className = "su-name";
  nameEl.textContent = d.name || d.key;
  const badge = document.createElement("span");
  badge.className = "su-badge";
  badge.textContent = `${shortLocation(d.location)} · 已停用`;
  titleRow.append(nameEl, badge);
  const cmd = document.createElement("div");
  cmd.className = "su-cmd";
  cmd.textContent = d.command;
  cmd.title = d.command;
  main.append(titleRow, cmd);
  const actions = document.createElement("div");
  actions.className = "su-actions";
  const btnRestore = document.createElement("button");
  btnRestore.className = "su-act";
  btnRestore.title = "恢复";
  btnRestore.textContent = "↩";
  btnRestore.onclick = (e) => { e.stopPropagation(); restoreDisabled(d, render); };
  const btnDrop = document.createElement("button");
  btnDrop.className = "su-act danger";
  btnDrop.title = "移出列表";
  btnDrop.textContent = "✕";
  btnDrop.onclick = (e) => { e.stopPropagation(); dropDisabled(d); render(); };
  actions.append(btnRestore, btnDrop);
  row.append(icon, main, actions);
  row.oncontextmenu = (ev) => {
    ev.preventDefault();
    closeMenus();
    buildMenu(ev.clientX, ev.clientY, disabledMenuEntries(d, render));
  };
  return row;
}

function mountStartup(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "🚀", "开机启动");
  shell.btnGear.remove();

  const toolbar = document.createElement("div");
  toolbar.className = "su-toolbar";
  const searchWrap = document.createElement("div");
  searchWrap.className = "su-search-wrap";
  const search = document.createElement("input");
  search.className = "su-search";
  search.placeholder = "搜索名称、命令或来源…";
  search.spellcheck = false;
  searchWrap.appendChild(search);
  const btnAll = document.createElement("button");
  btnAll.className = "su-tool-btn";
  btnAll.textContent = "浏览…";
  btnAll.title = "选择程序添加到开机启动";
  toolbar.append(searchWrap, btnAll);

  const inputRow = document.createElement("div");
  inputRow.className = "su-input-row";
  const nameInput = document.createElement("input");
  nameInput.className = "su-input-name";
  nameInput.placeholder = "名称（可选）";
  nameInput.spellcheck = false;
  const cmdInput = document.createElement("input");
  cmdInput.className = "su-input-cmd";
  cmdInput.placeholder = "程序或命令路径…（可拖拽文件到此处）";
  cmdInput.spellcheck = false;
  const btnBrowse = document.createElement("button");
  btnBrowse.className = "su-browse";
  btnBrowse.title = "浏览文件";
  btnBrowse.textContent = "…";
  const btnAdd = document.createElement("button");
  btnAdd.className = "su-add";
  btnAdd.title = "添加到开机启动（写入当前用户注册表）";
  btnAdd.textContent = "添加";
  inputRow.append(nameInput, cmdInput, btnBrowse, btnAdd);

  const list = document.createElement("div");
  list.className = "su-list";
  const dropveil = document.createElement("div");
  dropveil.className = "su-dropveil";
  dropveil.textContent = "松手添加到开机启动";

  shell.body.classList.add("su-body");
  shell.body.append(toolbar, inputRow, list);
  // 拖拽层叠在 list 上
  const bodyEl = shell.body;
  bodyEl.style.position = "relative";
  bodyEl.appendChild(dropveil);

  const footer = root.querySelector<HTMLElement>(".qw-footer");

  function setFooter(): void {
    if (!footer) return;
    if (loading) { footer.textContent = "读取中…"; return; }
    const total = items.length;
    const shown = filteredItems().length;
    const q = filterText.trim();
    if (disabled.length > 0) {
      footer.textContent = q ? `${shown}/${total} 个启动项 · ${disabled.length} 个已停用` : `${total} 个启动项 · ${disabled.length} 个已停用`;
    } else {
      footer.textContent = q ? `${shown}/${total} 个启动项` : `${total} 个启动项`;
    }
  }

  function filteredItems(): StartupItem[] {
    const q = filterText.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      (it.name && it.name.toLowerCase().includes(q)) ||
      it.key.toLowerCase().includes(q) ||
      it.command.toLowerCase().includes(q) ||
      locationLabel(it.location).toLowerCase().includes(q)
    );
  }

  function render(): void {
    list.innerHTML = "";
    const shown = filteredItems();
    const iconHolders: Array<{ source: string; box: HTMLElement }> = [];
    for (const item of shown) list.appendChild(rowEl(item, render, iconHolders));
    if (disabled.length > 0) {
      const title = document.createElement("div");
      title.className = "su-section-title";
      title.textContent = `已停用 · ${disabled.length}`;
      list.appendChild(title);
      for (const d of disabled) {
        const q = filterText.trim().toLowerCase();
        if (q && !(`${d.name} ${d.key} ${d.command} ${locationLabel(d.location)}`.toLowerCase().includes(q))) continue;
        list.appendChild(disabledRowEl(d, render));
      }
    }
    if (!loading && shown.length === 0 && disabled.length === 0) {
      const hint = document.createElement("div");
      hint.className = "su-empty";
      hint.innerHTML = filterText.trim() ? "没有匹配的启动项" : "没有发现开机启动项<br><span style='color:var(--text-dim);font-size:11px'>可拖拽程序到此或点击「浏览」添加</span>";
      list.appendChild(hint);
    } else if (!loading && shown.length === 0 && disabled.length > 0) {
      // 仅有已停用时不算空
    }
    setFooter();

    // 批量解析图标源（.lnk 解目标），再批量取图标
    if (iconHolders.length > 0) {
      const cmds = iconHolders.map((h) => h.source);
      void startupIconSources(cmds).then((sources) => {
        const pairs = iconHolders.map((h, i) => ({ source: sources[i] ?? h.source, box: h.box }));
        void paintIconsBatch(pairs);
      }).catch(() => {
        void paintIconsBatch(iconHolders);
      });
    }
  }

  const addItem = (): void => {
    const command = cmdInput.value.trim();
    if (!command) {
      toast("请先填写程序或命令路径");
      cmdInput.focus();
      return;
    }
    let name = nameInput.value.trim();
    if (!name) {
      const first = command.replace(/^"([^"]+)".*$/, "$1").split(/\s+/)[0];
      name = first.split(/[\\/]/).pop()?.replace(/\.[a-zA-Z0-9]+$/, "") || "新启动项";
    }
    btnAdd.disabled = true;
    void addStartupItem(name, command)
      .then(() => {
        cmdInput.value = "";
        nameInput.value = "";
        toast(`已添加「${name}」`);
        return load(render);
      })
      .catch((e) => toast(String(e)))
      .finally(() => { btnAdd.disabled = false; });
  };
  btnAdd.onclick = addItem;
  for (const input of [nameInput, cmdInput]) {
    input.onkeydown = (ev) => { if (ev.key === "Enter") addItem(); };
  }

  const pickFile = async (targetInput: HTMLInputElement): Promise<void> => {
    try {
      const picked = await openDialog({ multiple: false, filters: [{ name: "可执行文件", extensions: ["exe", "lnk", "bat", "cmd"] }] }) as string | null;
      if (picked) {
        targetInput.value = picked;
        targetInput.focus();
        // 若名称为空，自动填
        if (!nameInput.value.trim()) {
          const base = picked.split(/[\\/]/).pop()?.replace(/\.[a-zA-Z0-9]+$/, "") ?? "";
          if (base) nameInput.value = base;
        }
      }
    } catch (e) { toast(String(e)); }
  };
  btnBrowse.onclick = () => void pickFile(cmdInput);
  btnAll.onclick = () => void pickFile(cmdInput);

  // 拖拽导入：文件拖到输入框或列表均可
  const onDragOver = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      bodyEl.classList.add("drag-over");
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDragLeave = (e: DragEvent): void => {
    if (!bodyEl.contains(e.relatedTarget as Node)) bodyEl.classList.remove("drag-over");
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    bodyEl.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // Tauri webview 的 file.path 在不同版本暴露方式不同，优先取 path
    const first = files[0] as unknown as { path?: string };
    const p = first.path ?? (files[0] as unknown as { name: string }).name;
    // 若只有文件名，回退到 dataTransfer getData
    const fallback = e.dataTransfer?.getData("text/plain")?.trim();
    const chosen = (p && p.includes(":\\") ? p : fallback) ?? p;
    if (chosen) {
      cmdInput.value = chosen;
      if (!nameInput.value.trim()) {
        const base = chosen.split(/[\\/]/).pop()?.replace(/\.[a-zA-Z0-9]+$/, "") ?? "";
        if (base) nameInput.value = base;
      }
      toast("已填入拖拽文件，可修改后点击添加");
    }
  };
  bodyEl.addEventListener("dragover", onDragOver);
  bodyEl.addEventListener("dragleave", onDragLeave);
  bodyEl.addEventListener("drop", onDrop);
  // 传统拖拽事件兜底
  cmdInput.addEventListener("dragover", (e) => e.preventDefault());
  cmdInput.addEventListener("drop", onDrop as never);

  search.addEventListener("input", () => {
    filterText = search.value;
    render();
  });

  shell.btnRefresh.onclick = () => void load(render);

  void widgetLoad<Partial<{ disabled: DisabledItem[] }>>("startup", {}).then((d) => {
    const arr = Array.isArray(d.disabled) ? d.disabled : [];
    disabled = arr.filter((x): x is DisabledItem => typeof x?.location === "string" && typeof x?.key === "string" && typeof x?.command === "string");
    render();
  });

  void load(render);
  render();

  return () => {
    window.clearTimeout(saveTimer);
    bodyEl.removeEventListener("dragover", onDragOver);
    bodyEl.removeEventListener("dragleave", onDragLeave);
    bodyEl.removeEventListener("drop", onDrop);
  };
}

registerWidget({
  id: "startup",
  name: "开机启动",
  icon: "🚀",
  color: "#38bdf8",
  desc: "查看与管理开机自启动项",
  width: 400,
  height: 520,
  minWidth: 320,
  minHeight: 260,
  mount: (root) => mountStartup(root),
  summary: async () => {
    try {
      const n = (await listStartupItems()).length;
      return `${n} 个启动项`;
    } catch { return "查看与管理开机自启动项"; }
  },
});

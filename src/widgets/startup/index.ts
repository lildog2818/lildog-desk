import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  addStartupItem,
  listStartupItems,
  removeStartupItem,
  STARTUP_LOCATION_LABEL,
  startupEdit,
  startupRestore,
  startupTargetPath,
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

const FOLDER_LOCATIONS = new Set(["user-startup", "common-startup"]);

/** 被关闭开机自启、但保留恢复入口的启动项 */
interface DisabledItem {
  location: string;
  key: string;
  name: string;
  command: string;
}

let items: StartupItem[] = [];
let disabled: DisabledItem[] = [];
let loading = false;
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

function fallbackEmoji(loc: string): string {
  return LOCATION_ICON[loc] ?? "⚙️";
}

/** 图标源：文件夹项直接用文件路径；注册表项解析命令行取可执行文件 */
async function resolveIconPath(item: StartupItem): Promise<string> {
  if (FOLDER_LOCATIONS.has(item.location)) return item.command;
  try {
    return await startupTargetPath(item.command);
  } catch {
    return "";
  }
}

function setIconImg(box: HTMLElement, path: string): void {
  box.textContent = "";
  const img = document.createElement("img");
  img.src = convertFileSrc(path);
  img.draggable = false;
  box.appendChild(img);
}

async function paintIcon(item: StartupItem, box: HTMLElement): Promise<void> {
  const source = await resolveIconPath(item);
  if (!source) {
    box.textContent = fallbackEmoji(item.location);
    return;
  }
  const cached = iconCache.get(source);
  if (cached) {
    setIconImg(box, cached);
    return;
  }
  if (iconFailed.has(source)) {
    box.textContent = fallbackEmoji(item.location);
    return;
  }
  try {
    const p = await invoke<string>("get_icon", { path: source });
    if (p) {
      iconCache.set(source, p);
      if (box.isConnected) setIconImg(box, p);
    } else {
      iconFailed.add(source);
      if (box.isConnected) box.textContent = fallbackEmoji(item.location);
    }
  } catch {
    iconFailed.add(source);
    if (box.isConnected) box.textContent = fallbackEmoji(item.location);
  }
}

/** 带命令/路径输入的弹窗 */
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
    // 移除与现存启动项重复的停用记录（例如用户手动重新添加过）
    const liveKeys = new Set(items.map((i) => `${i.location}:${i.key}`));
    const filtered = disabled.filter(
      (d) => !liveKeys.has(`${d.location}:${d.key}`),
    );
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
  void navigator.clipboard
    .writeText(command)
    .then(() => toast("已复制命令"))
    .catch(() => toast("复制失败"));
}

function revealItem(item: StartupItem): void {
  void resolveIconPath(item).then((p) => {
    if (!p) {
      toast("未找到目标路径");
      return;
    }
    void invoke("reveal_target", { target: p }).catch((e) => toast(String(e)));
  });
}

function disableItem(item: StartupItem, render: () => void): void {
  confirmDanger(
    `将取消「${item.name || item.key}」的开机自启（${locationLabel(item.location)}），并保留恢复入口，确定？`,
    () => {
      void (async () => {
        // 文件夹 .lnk 项先解析真实指向，以便日后恢复时重建
        let command = item.command;
        if (
          FOLDER_LOCATIONS.has(item.location) &&
          command.toLowerCase().endsWith(".lnk")
        ) {
          command = await invoke<string>("startup_lnk_command", {
            path: command,
          }).catch(() => command);
        }
        await removeStartupItem(item.location, item.key);
        disabled.push({
          location: item.location,
          key: item.key,
          name: item.name,
          command,
        });
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
      disabled = disabled.filter(
        (x) => !(x.location === d.location && x.key === d.key),
      );
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
        .then(() => {
          toast("已删除该启动项");
          return load(render);
        })
        .catch((e) => toast(String(e)));
    },
  );
}

function dropDisabled(d: DisabledItem, render: () => void): void {
  disabled = disabled.filter(
    (x) => !(x.location === d.location && x.key === d.key),
  );
  persistDisabled();
  toast("已移出列表");
  render();
}

// ---------------- 渲染 ----------------

function itemMenuEntries(
  item: StartupItem,
  render: () => void,
): MenuEntry[] {
  const isFolderFile = FOLDER_LOCATIONS.has(item.location);
  const lnkEditable =
    !isFolderFile || item.command.toLowerCase().endsWith(".lnk");
  return [
    {
      label: "修改指向目标…",
      disabled: !lnkEditable,
      action: () => editTarget(item, render),
    },
    { label: "复制命令", action: () => copyCommand(item.command) },
    { label: "打开所在位置", action: () => revealItem(item) },
    { label: undefined, action: undefined },
    {
      label: "关闭开机自启",
      action: () => disableItem(item, render),
    },
    { label: "删除", danger: true, action: () => deleteItem(item, render) },
  ];
}

function disabledMenuEntries(
  d: DisabledItem,
  render: () => void,
): MenuEntry[] {
  return [
    { label: "恢复开机自启", action: () => restoreDisabled(d, render) },
    { label: "复制命令", action: () => copyCommand(d.command) },
    { label: undefined, action: undefined },
    { label: "移出列表", danger: true, action: () => dropDisabled(d, render) },
  ];
}

/** 图标磁贴：图标在上、名称在下，居中排列。
 * command 为空时不绘制真实图标，仅显示来源占位符（停用项）；
 * 传入真实 location 保证文件夹项直接使用完整文件路径取图标（路径可能含空格）。
 */
function tileEl(
  className: string,
  title: string,
  location: string,
  command: string | null,
  fallback: string,
  name: string,
  onMenu: (ev: MouseEvent) => void,
): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = className;
  tile.title = title;

  const icon = document.createElement("div");
  icon.className = "su-icon";
  icon.textContent = fallback;
  if (command) {
    const pseudo: StartupItem = {
      location,
      key: "",
      name,
      command,
    };
    void paintIcon(pseudo, icon);
  }

  const label = document.createElement("div");
  label.className = "su-name";
  label.textContent = name;

  tile.append(icon, label);
  tile.oncontextmenu = (ev) => {
    ev.preventDefault();
    closeMenus();
    onMenu(ev);
  };
  return tile;
}

function rowEl(item: StartupItem, render: () => void): HTMLDivElement {
  return tileEl(
    "su-item",
    `${item.name || item.key}\n${item.command}\n来源：${locationLabel(item.location)}`,
    item.location,
    item.command,
    fallbackEmoji(item.location),
    item.name || item.key,
    (ev) => buildMenu(ev.clientX, ev.clientY, itemMenuEntries(item, render)),
  );
}

function disabledRowEl(d: DisabledItem, render: () => void): HTMLDivElement {
  return tileEl(
    "su-item su-disabled",
    `${d.name}\n${d.command}\n已停用（来源：${locationLabel(d.location)}）`,
    d.location,
    null,
    LOCATION_ICON[d.location] ?? "⏸",
    d.name || d.key,
    (ev) => buildMenu(ev.clientX, ev.clientY, disabledMenuEntries(d, render)),
  );
}

function mountStartup(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "🚀", "开机启动");
  shell.btnGear.remove();

  const inputRow = document.createElement("div");
  inputRow.className = "su-input-row";
  const nameInput = document.createElement("input");
  nameInput.className = "su-input-name";
  nameInput.placeholder = "名称（可选）";
  nameInput.spellcheck = false;
  const cmdInput = document.createElement("input");
  cmdInput.className = "su-input-cmd";
  cmdInput.placeholder = "程序或命令路径…";
  cmdInput.spellcheck = false;
  const btnAdd = document.createElement("button");
  btnAdd.className = "su-add";
  btnAdd.title = "添加到开机启动（写入当前用户注册表）";
  btnAdd.textContent = "＋";
  inputRow.append(nameInput, cmdInput, btnAdd);

  const list = document.createElement("div");
  list.className = "su-list";

  shell.body.classList.add("su-body");
  shell.body.append(inputRow, list);

  const liveCount = (): number => items.length;

  function render(): void {
    list.innerHTML = "";
    for (const item of items) list.appendChild(rowEl(item, render));
    for (const d of disabled) list.appendChild(disabledRowEl(d, render));
    if (!loading && items.length === 0 && disabled.length === 0) {
      const hint = document.createElement("div");
      hint.className = "su-empty";
      hint.textContent = "没有发现开机启动项";
      list.appendChild(hint);
    }
    const footer = root.querySelector<HTMLElement>(".qw-footer");
    if (footer) {
      footer.textContent = loading
        ? "读取中…"
        : disabled.length > 0
          ? `${liveCount()} 个启动项 · ${disabled.length} 个已停用`
          : `${liveCount()} 个启动项`;
    }
  }

  const addItem = (): void => {
    const command = cmdInput.value.trim();
    if (!command) {
      toast("请先填写程序或命令路径");
      cmdInput.focus();
      return;
    }
    // 名称留空时从命令首段推导
    let name = nameInput.value.trim();
    if (!name) {
      const first = command.replace(/^"([^"]+)".*$/, "$1").split(/\s+/)[0];
      name =
        first
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[a-zA-Z0-9]+$/, "") || "新启动项";
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
      .finally(() => {
        btnAdd.disabled = false;
      });
  };
  btnAdd.onclick = addItem;
  for (const input of [nameInput, cmdInput]) {
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") addItem();
    };
  }

  shell.btnRefresh.onclick = () => void load(render);

  void widgetLoad<Partial<{ disabled: DisabledItem[] }>>("startup", {}).then(
    (d) => {
      const arr = Array.isArray(d.disabled) ? d.disabled : [];
      disabled = arr.filter(
        (x): x is DisabledItem =>
          typeof x?.location === "string" &&
          typeof x?.key === "string" &&
          typeof x?.command === "string",
      );
      render();
    },
  );

  void load(render);
  render();

  return () => {
    window.clearTimeout(saveTimer);
  };
}

registerWidget({
  id: "startup",
  name: "开机启动",
  icon: "🚀",
  color: "#38bdf8",
  desc: "查看与管理开机自启动项",
  width: 380,
  height: 480,
  minWidth: 280,
  minHeight: 220,
  mount: (root) => mountStartup(root),
  summary: async () => {
    try {
      const n = (await listStartupItems()).length;
      return `${n} 个启动项`;
    } catch {
      return "查看与管理开机自启动项";
    }
  },
});
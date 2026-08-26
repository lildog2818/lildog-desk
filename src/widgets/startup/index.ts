import {
  addStartupItem,
  listStartupItems,
  removeStartupItem,
  STARTUP_LOCATION_LABEL,
  type StartupItem,
} from "../../platform/startup";
import { registerWidget } from "../../platform/registry";
import { confirmDanger, toast } from "../../platform/shell";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/startup.css";

const LOCATION_ICON: Record<string, string> = {
  "hkcu-run": "👤",
  "hklm-run": "🛡️",
  "user-startup": "📁",
  "common-startup": "🗂️",
};

let items: StartupItem[] = [];
let loading = false;

function locationLabel(loc: string): string {
  return STARTUP_LOCATION_LABEL[loc] ?? loc;
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
    render();
  }
}

function rowEl(item: StartupItem, render: () => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "su-item";

  const icon = document.createElement("div");
  icon.className = "su-icon";
  icon.textContent = LOCATION_ICON[item.location] ?? "⚙️";
  icon.title = `来源：${locationLabel(item.location)}`;

  const main = document.createElement("div");
  main.className = "su-main";
  const name = document.createElement("div");
  name.className = "su-name";
  name.textContent = item.name || item.key;
  name.title = `${item.name || item.key}\n来源：${locationLabel(item.location)}`;
  const cmd = document.createElement("div");
  cmd.className = "su-cmd";
  cmd.textContent = item.command || "（空命令）";
  cmd.title = item.command;
  main.append(name, cmd);

  const del = document.createElement("button");
  del.className = "su-del";
  del.title = "取消此启动项";
  del.textContent = "✕";
  del.onclick = (ev) => {
    ev.stopPropagation();
    confirmDanger(
      `将取消「${item.name || item.key}」的开机启动（${
        item.location === "hklm-run"
          ? "所有用户 · 注册表，需要管理员权限"
          : locationLabel(item.location)
      }），确定删除？`,
      () => {
        void removeStartupItem(item.location, item.key)
          .then(() => {
            toast("已取消该启动项");
            return load(render);
          })
          .catch((e) => toast(String(e)));
      },
    );
  };

  row.append(icon, main, del);
  return row;
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

  function render(): void {
    list.innerHTML = "";
    for (const item of items) list.appendChild(rowEl(item, render));
    if (!loading && items.length === 0) {
      const hint = document.createElement("div");
      hint.className = "su-empty";
      hint.textContent = "没有发现开机启动项";
      list.appendChild(hint);
    }
    const footer = root.querySelector<HTMLElement>(".qw-footer");
    if (footer)
      footer.textContent = loading ? "读取中…" : `${items.length} 个启动项`;
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

  void load(render);
  render();

  return () => {};
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

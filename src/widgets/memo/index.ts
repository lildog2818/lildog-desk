import { getWindowState, setPinned } from "../../platform/winstate";
import { registerWidget } from "../../platform/registry";
import { toast } from "../../platform/shell";
import { widgetLoad, widgetSave } from "../../platform/widget-data";
import { buildWidgetShell } from "../quota-shared";
import "./../../styles/memo.css";

interface MemoItem {
  id: string;
  text: string;
  done: boolean;
}

interface MemoData {
  items: MemoItem[];
}

const DEFAULT_DATA: MemoData = { items: [] };

function uid(): string {
  return crypto.randomUUID();
}

let saveTimer = 0;
let data: MemoData = { ...DEFAULT_DATA };

function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void widgetSave("memo", structuredClone(data));
  }, 250);
}

function mountMemo(root: HTMLElement): () => void {
  const shell = buildWidgetShell(root, "📝", "备忘录");
  // 备忘录不需要刷新与设置按钮，仅保留固定
  shell.btnRefresh.remove();
  shell.btnGear.remove();

  const inputRow = document.createElement("div");
  inputRow.className = "memo-input-row";
  const input = document.createElement("input");
  input.className = "memo-input";
  input.placeholder = "记录一点什么…（回车添加）";
  input.spellcheck = false;
  const btnAdd = document.createElement("button");
  btnAdd.className = "memo-add";
  btnAdd.title = "添加";
  btnAdd.textContent = "＋";
  inputRow.append(input, btnAdd);

  const list = document.createElement("div");
  list.className = "memo-list";

  shell.body.classList.add("memo-body");
  shell.body.append(inputRow, list);

  const addItem = (): void => {
    const text = input.value.trim();
    if (!text) return;
    data.items.unshift({ id: uid(), text, done: false });
    input.value = "";
    persist();
    render();
  };
  btnAdd.onclick = addItem;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") addItem();
  };

  function render(): void {
    list.innerHTML = "";
    for (const item of data.items) {
      const row = document.createElement("div");
      row.className = "memo-item" + (item.done ? " done" : "");

      const check = document.createElement("button");
      check.className = "memo-check";
      check.title = item.done ? "标记为未完成" : "标记为已完成";
      if (item.done) check.textContent = "✓";
      check.onclick = () => {
        item.done = !item.done;
        persist();
        render();
      };

      const text = document.createElement("div");
      text.className = "memo-text";
      text.textContent = item.text;

      const del = document.createElement("button");
      del.className = "memo-del";
      del.title = "删除";
      del.textContent = "✕";
      del.onclick = () => {
        data.items = data.items.filter((i) => i.id !== item.id);
        persist();
        render();
      };

      row.append(check, text, del);
      list.appendChild(row);
    }

    if (data.items.length === 0) {
      const hint = document.createElement("div");
      hint.className = "memo-empty";
      hint.textContent = "还没有备忘，先添加一条吧";
      list.appendChild(hint);
    }
  }

  void widgetLoad<MemoData>("memo", { ...DEFAULT_DATA }).then((d) => {
    data = {
      items: Array.isArray(d.items)
        ? d.items.filter(
            (i): i is MemoItem =>
              typeof i?.id === "string" &&
              typeof i?.text === "string" &&
              typeof i?.done === "boolean",
          )
        : [],
    };
    render();
  });

  // 固定状态与快捷启动一致
  const pinBtn = shell.btnPin;
  pinBtn.title = "钉住置顶";
  void getWindowState()
    .then((st) => pinBtn.classList.toggle("active", st.pinned))
    .catch(() => {});
  pinBtn.onclick = () => {
    const next = !pinBtn.classList.contains("active");
    pinBtn.classList.toggle("active", next);
    void setPinned(next).catch((e) => {
      pinBtn.classList.toggle("active", !next);
      toast(String(e));
    });
  };

  render();

  return () => {
    window.clearTimeout(saveTimer);
  };
}

registerWidget({
  id: "memo",
  name: "备忘录",
  icon: "📝",
  color: "#34d399",
  desc: "随手记录文字，勾选标记完成",
  width: 300,
  height: 420,
  minWidth: 240,
  minHeight: 200,
  mount: (root) => mountMemo(root),
  summary: async () => {
    const d = await widgetLoad<MemoData>("memo", { items: [] });
    const pending = (d.items ?? []).filter((i) => !i.done).length;
    return pending > 0 ? `${pending} 条待办` : "暂无待办事项";
  },
});

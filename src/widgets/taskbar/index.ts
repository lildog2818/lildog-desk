import { registerWidget } from "../../platform/registry";
import { getTaskbarEffect } from "../../platform/winstate";

// ---------------- 原生任务栏风格替换（开关组件） ----------------
//
// 在控制台双击本组件卡片即可直接应用效果，再次双击还原系统默认，
// 不再弹出悬浮窗。效果与其他所有小组件完全一致：亚克力材质 +
// 应用主题背景色 + 面板透明度，参数随外观菜单的全局设置一起调节，
// 没有独立调节框。实际生效逻辑在后端 nativebar 模块，不依赖前端存活。

registerWidget({
  id: "taskbar",
  name: "任务栏",
  icon: "🖥️",
  color: "#7dd3fc",
  desc: "双击卡片直接应用原生任务栏效果，再次双击还原系统默认",
  width: 300,
  height: 320,
  // 兜底视图：本组件正常情况下不打开悬浮窗（控制台双击即切换开关）
  mount: (root: HTMLElement) => {
    root.innerHTML =
      '<div class="empty-hint"><span class="dog">🖥️</span>在控制台双击「任务栏」卡片<br />即可开启 / 关闭效果</div>';
  },
  summary: async () =>
    (await getTaskbarEffect().catch(() => false))
      ? "已应用 · 与小组件同款效果"
      : "未应用 · 双击立即套用",
});

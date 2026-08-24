import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/glass.css";
import "./styles/dashboard.css";
import { getWidget } from "./platform/registry";
import { installGlobalDismiss } from "./platform/shell";
import { initAppearance } from "./platform/appearance";
import { renderDashboard } from "./views/dashboard";
import "./widgets/launcher";
import "./widgets/opencode-quota";
import "./widgets/deepseek-balance";
import "./widgets/memo";

installGlobalDismiss();
initAppearance();

async function route(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;
  const label = getCurrentWindow().label;
  app.innerHTML = "";

  if (!label.startsWith("w-")) {
    await renderDashboard(app);
    return;
  }

  const id = label.slice(2);
  const def = getWidget(id);
  if (!def) {
    app.innerHTML =
      '<div class="empty-hint"><span class="dog">🫥</span>未知的小组件</div>';
    return;
  }

  try {
    await def.mount(app, { windowLabel: label, embedded: false });
  } catch (e) {
    app.innerHTML = `<div class="empty-hint"><span class="dog">💥</span>${String(e)}</div>`;
  }
}

void route();

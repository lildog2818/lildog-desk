import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** 仅用于本地预览小组件外观（不参与应用构建）：把 Tauri API 换成浏览器桩 */
const stub = (name: string): string =>
  fileURLToPath(new URL(`./tools/preview/stubs/${name}`, import.meta.url));

export default defineConfig({
  root: "tools/preview",
  server: { port: 4178, strictPort: true },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: stub("core.ts") },
      { find: "@tauri-apps/api/window", replacement: stub("window.ts") },
      { find: "@tauri-apps/api/webview", replacement: stub("webview.ts") },
      { find: "@tauri-apps/api/event", replacement: stub("event.ts") },
    ],
  },
  build: {
    outDir: "../../.preview-dist",
    emptyOutDir: true,
  },
});

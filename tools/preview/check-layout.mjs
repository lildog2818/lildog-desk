/**
 * 排版体检：用无头 Edge 逐个窗口尺寸渲染番茄钟，读取每个关键元素的实际矩形，
 * 在 Node 侧判断是否有重叠/溢出。避免"靠肉眼看截图"漏掉问题。
 *
 *   node tools/preview/check-layout.mjs [scene]
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 Edge，无法体检");
  process.exit(2);
}

const BASE = process.env.PREVIEW_URL || "http://localhost:4178/preview.html";
const scene = process.argv[2] || "focus";
const SIZES = [
  [240, 340],
  [260, 380],
  [280, 400],
  [288, 416],
  [300, 440],
  [320, 460],
  [320, 520],
  [340, 600],
  [360, 680],
];

/** 让页面自己把关键矩形吐出来（靠 DOM 测量，比读截图可靠） */
const PROBE = `(() => {
  const q = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), b: +r.bottom.toFixed(1), r: +r.right.toFixed(1) };
  };
  const app = document.getElementById("app");
  return JSON.stringify({
    app: app ? { w: app.clientWidth, h: app.clientHeight } : null,
    fit: getComputedStyle(app).getPropertyValue("--pm-fit").trim(),
    time: q(".pm-time"),
    status: q(".pm-status"),
    task: q(".pm-task"),
    controls: q(".pm-controls"),
    field: q(".pm-field"),
    ringbox: q(".pm-ringbox"),
    tabs: q(".pm-tabs"),
  });
})()`;

function overlap(a, b) {
  return a.r > b.l + 0.5 && b.r > a.l - 0.5 && a.b > b.t + 0.5;
}

const profile = await mkdtemp(join(tmpdir(), "pm-check-"));
let failures = 0;

for (const [w, h] of SIZES) {
  const url = `${BASE}?scene=${scene}&w=${w}&h=${h}`;
  // --dump-dom 会等页面加载完；再用 evaluate 式的方式拿数据：这里用临时 HTML 注入
  const probeUrl = `${url}&probe=1`;
  let out = "";
  try {
    const res = await run(
      EDGE,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        `--window-size=${w + 20},${h + 20}`,
        "--virtual-time-budget=2500",
        "--dump-dom",
        probeUrl,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    out = res.stdout;
  } catch (e) {
    console.error(`${w}x${h}: 渲染失败 ${e.message}`);
    failures += 1;
    continue;
  }

  // 页面把探针结果写进 <title>，这里从 DOM 里取
  const m = /<title>([^<]*)<\/title>/.exec(out);
  const raw = m?.[1]?.trim();
  if (!raw || raw === "番茄钟预览") {
    console.error(`${w}x${h}: 未取到探针数据`);
    failures += 1;
    continue;
  }
  const d = JSON.parse(raw.replace(/&quot;/g, '"'));
  const issues = [];
  const pairs = [
    ["time", "status"],
    ["status", "task"],
    ["time", "task"],
    ["task", "controls"],
    ["controls", "field"],
  ];
  for (const [a, b] of pairs) {
    if (d[a] && d[b] && overlap(d[a], d[b])) issues.push(`${a}×${b}`);
  }

  // 设计约定：数字在圆环内，状态行在圆环下方（不再叠在圈上）。
  // 1) 数字必须完整落在圆环笔画内沿以内（四周留内边距）
  const innerD = d.ringbox.w * (1 - 7 / 100);
  if (d.timeTextW > innerD - 12)
    issues.push(`数字宽 ${d.timeTextW} 超出圆环内径 ${innerD.toFixed(1)}`);
  if (d.timeInner.h > innerD - 12)
    issues.push(`数字高 ${d.timeInner.h} 超出圆环内径`);
  // 数字要水平、垂直居中于圆环
  const ringCx = (d.ringbox.l + d.ringbox.r) / 2;
  const ringCy = (d.ringbox.t + d.ringbox.b) / 2;
  const timeCx = (d.timeInner.l + d.timeInner.r) / 2;
  const timeCy = (d.timeInner.t + d.timeInner.b) / 2;
  if (Math.abs(timeCx - ringCx) > 2) issues.push("数字未水平居中");
  if (Math.abs(timeCy - ringCy) > 2) issues.push("数字未垂直居中");

  // 2) 状态行必须在圆环下方，且保留间距（不许压在圈上）
  const gapBelowRing = d.status.t - d.ringbox.b;
  if (gapBelowRing < 2)
    issues.push(`状态行与圆环间距仅 ${gapBelowRing.toFixed(1)}px（应位于圆环下方）`);
  if (d.statusInner.t < d.ringbox.b)
    issues.push("状态行与圆环重叠");
  if (d.statusTextW > d.app.w - 8)
    issues.push(`状态行文字 ${d.statusTextW} 超出窗口宽 ${d.app.w}`);
  // 底部元素不能越过窗口底边（#app 有 1px 边框，留 2px 容差）
  const bottom = d.app.b;
  if (d.field.b > bottom + 2) issues.push(`field 溢出底部 ${d.field.b}>${bottom}`);
  if (d.controls.b > bottom + 2) issues.push(`controls 溢出底部 ${d.controls.b}>${bottom}`);
  if (d.time.b > d.controls.t - 1) issues.push("time 压到按钮");

  const tag = issues.length ? `FAIL  ${issues.join(", ")}` : "PASS";
  if (issues.length) failures += 1;
  console.log(
    `${String(w).padStart(3)}x${String(h).padStart(3)}  fit=${d.fit}  环=${d.ringbox.w}  数字=${d.timeTextW}x${d.timeInner.h}  环下间距=${(d.status.t - d.ringbox.b).toFixed(1)}  ${tag}`,
  );
}

await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(failures === 0 ? "\n全部尺寸通过" : `\n${failures} 个尺寸有问题`);
process.exit(failures === 0 ? 0 : 1);

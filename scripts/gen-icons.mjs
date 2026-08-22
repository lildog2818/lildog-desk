import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function inRoundRect(u, v) {
  const r = 0.24;
  const cx = 0.5;
  const cy = 0.5;
  const hx = 0.5 - r;
  const hy = 0.5 - r;
  const qx = Math.max(Math.abs(u - cx) - hx, 0);
  const qy = Math.max(Math.abs(v - cy) - hy, 0);
  return Math.hypot(qx, qy) <= r || (Math.abs(u - cx) <= hx && Math.abs(v - cy) <= hy);
}

function inTriangle(u, v, p1, p2, p3) {
  const s = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const d1 = s(p1, p2, [u, v]);
  const d2 = s(p2, p3, [u, v]);
  const d3 = s(p3, p1, [u, v]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function inEllipse(u, v, cx, cy, rx, ry) {
  const dx = (u - cx) / rx;
  const dy = (v - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function shade(u, v) {
  const bgTop = [255, 184, 77];
  const bgBot = [255, 128, 56];
  if (!inRoundRect(u, v)) return [0, 0, 0, 0];
  let color = mix(bgTop, bgBot, v);
  if (
    inTriangle(u, v, [0.14, 0.47], [0.42, 0.34], [0.17, 0.07]) ||
    inTriangle(u, v, [0.86, 0.47], [0.58, 0.34], [0.83, 0.07])
  )
    color = [110, 74, 43];
  if (Math.hypot(u - 0.5, v - 0.57) <= 0.34) color = [255, 231, 196];
  if (inEllipse(u, v, 0.5, 0.72, 0.21, 0.15)) color = [255, 247, 234];
  if (Math.hypot(u - 0.37, v - 0.52) <= 0.042 || Math.hypot(u - 0.63, v - 0.52) <= 0.042)
    color = [58, 42, 26];
  if (inEllipse(u, v, 0.5, 0.68, 0.055, 0.04)) color = [58, 42, 26];
  return [...color, 255];
}

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const c = shade(u, v);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

mkdirSync(outDir, { recursive: true });

for (const s of [32, 128, 256, 512]) {
  const name = s === 512 ? "icon.png" : s === 256 ? "128x128@2x.png" : `${s}x${s}.png`;
  writeFileSync(join(outDir, name), encodePng(s, s, render(s)));
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((s) => encodePng(s, s, render(s)));
let offset = 6 + icoSizes.length * 16;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
const dirParts = [];
for (let i = 0; i < icoSizes.length; i++) {
  const s = icoSizes[i];
  const e = Buffer.alloc(16);
  e[0] = s % 256;
  e[1] = s % 256;
  e[2] = 0;
  e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  dirParts.push(e);
}
writeFileSync(
  join(outDir, "icon.ico"),
  Buffer.concat([header, ...dirParts, ...pngs]),
);

console.log("icons generated:", outDir);

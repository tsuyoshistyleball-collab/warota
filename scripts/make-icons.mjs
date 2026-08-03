// PWA 用 PNG アイコンを依存ライブラリなしで生成する (icon.svg と同じデザイン)。
// 生成物はコミット済みのため通常は再実行不要。デザイン変更時のみ実行する。

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "public");

// ---- PNG エンコーダ ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 描画 ----
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 512; // 512 基準の座標系
  const cx = 256 * s;
  const cy = 352 * s;
  const dotR = 34 * s;
  const arcs = [98, 157, 216].map((r) => r * s);
  const arcW = 26 * s;
  const soft = 1.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = y / size;
      let r = 0x23 + (0x12 - 0x23) * t;
      let g = 0x29 + (0x16 - 0x29) * t;
      let b = 0x46 + (0x29 - 0x46) * t;

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);

      // 中心のドット
      let cov = clamp01(dotR - dist + soft);
      // 上方向 90 度の扇形に広がる電波アーク
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang > -135 - 3 && ang < -45 + 3) {
        for (const ar of arcs) {
          cov = Math.max(cov, clamp01(arcW / 2 - Math.abs(dist - ar) + soft));
        }
      }
      if (cov > 0) {
        r = r * (1 - cov) + 0xff * cov;
        g = g * (1 - cov) + 0x89 * cov;
        b = b * (1 - cov) + 0x06 * cov;
      }

      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

await writeFile(path.join(OUT, "icon-512.png"), draw(512));
await writeFile(path.join(OUT, "icon-192.png"), draw(192));
await writeFile(path.join(OUT, "apple-touch-icon.png"), draw(180));
console.log("icons written to public/");

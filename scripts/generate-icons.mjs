/**
 * Generates the extension icon set as PNGs without any rasterizer dependency.
 * A minimal PNG encoder (zlib deflate + CRC32) draws a rounded, gradient
 * square with a chat bubble and three dots.
 *
 * Output: static/icons/icon-{16,32,48,96,128}.png
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");

// ---- minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** pixelFn(x, y) -> [r, g, b, a] with x,y in [0, 1). */
function encodePng(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x / size, y / size);
      const off = y * (size * 4 + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing ---------------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function roundedRectMask(x, y, r) {
  const cx = clamp01((x - r) / (1 - 2 * r));
  const cy = clamp01((y - r) / (1 - 2 * r));
  const dx = x - (r + cx * (1 - 2 * r));
  const dy = y - (r + cy * (1 - 2 * r));
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function circle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

const lerp = (a, b, t) => a + (b - a) * t;

function drawIcon(x, y) {
  // Rounded square with a diagonal indigo gradient.
  const mask = roundedRectMask(x, y, 0.22);
  if (mask === 0) return [0, 0, 0, 0];
  const grad = clamp01(x * 0.7 + y * 0.5);
  let r = lerp(30, 79, grad);
  let g = lerp(27, 70, grad);
  let b = lerp(75, 144, grad);

  // Chat bubble: white rounded shape (circle + tail).
  const bubble = circle(x, y, 0.5, 0.47, 0.3) || (x > 0.36 && x < 0.5 && y > 0.7 && y < 0.78 ? 1 : 0);
  if (bubble) {
    r = 248;
    g = 250;
    b = 252;
  }
  // Three dots in the bubble.
  for (const dx of [-0.09, 0, 0.09]) {
    if (circle(x, y, 0.5 + dx, 0.47, 0.045) && bubble) {
      r = 67;
      g = 56;
      b = 202;
    }
  }
  // Sparkle top-right.
  const star =
    circle(x, y, 0.76, 0.24, 0.05) ||
    circle(x, y, 0.76, 0.24, 0.012) && x > 0.76 - 0.02 && x < 0.76 + 0.02 ||
    (Math.abs(x - 0.76) < 0.012 && y > 0.19 && y < 0.29 ? 1 : 0) ||
    (Math.abs(y - 0.24) < 0.012 && x > 0.71 && x < 0.81 ? 1 : 0);
  if (star && bubble === 0) {
    r = 253;
    g = 224;
    b = 71;
  }
  return [r, g, b, 255];
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), encodePng(size, drawIcon));
  console.log(`wrote static/icons/icon-${size}.png`);
}

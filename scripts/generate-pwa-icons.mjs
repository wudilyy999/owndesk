// Draws the PWA icons (a chat bubble with three typing dots) into public/icons.
// Pure node: PNG is written with zlib, no image library. Run: node scripts/generate-pwa-icons.mjs
import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BG = [0x1e, 0x19, 0x15]
const BUBBLE = [0xf8, 0xf5, 0xee]
const DOT = [0xb5, 0x53, 0x2a]

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
const inTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
  const d1 = d(x, y, ax, ay, bx, by)
  const d2 = d(x, y, bx, by, cx, cy)
  const d3 = d(x, y, cx, cy, ax, ay)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

// [r, g, b, a] of one point in the unit square
function sample(x, y, { rounded, scale }) {
  if (rounded && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0]
  // the glyph is scaled about the centre; the maskable icon keeps it in the safe zone
  const gx = (x - 0.5) / scale + 0.5
  const gy = (y - 0.5) / scale + 0.5
  for (const cx of [0.35, 0.5, 0.65])
    if ((gx - cx) ** 2 + (gy - 0.46) ** 2 <= 0.048 ** 2) return [...DOT, 255]
  if (
    inRoundRect(gx, gy, 0.2, 0.25, 0.8, 0.67, 0.11) ||
    inTriangle(gx, gy, [0.3, 0.62], [0.3, 0.8], [0.5, 0.64])
  )
    return [...BUBBLE, 255]
  return [...BG, 255]
}

function render(size, options) {
  const grid = 4
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < grid; sy++)
        for (let sx = 0; sx < grid; sx++) {
          const s = sample(
            (px + (sx + 0.5) / grid) / size,
            (py + (sy + 0.5) / grid) / size,
            options
          )
          r += s[0] * s[3]
          g += s[1] * s[3]
          b += s[2] * s[3]
          a += s[3]
        }
      const at = py * (size * 4 + 1) + 1 + px * 4
      raw[at] = a ? Math.round(r / a) : 0
      raw[at + 1] = a ? Math.round(g / a) : 0
      raw[at + 2] = a ? Math.round(b / a) : 0
      raw[at + 3] = Math.round(a / (grid * grid))
    }
  }
  return png(size, size, raw)
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc(body), body.length + 4)
  return out
}
function png(width, height, raw) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons")
mkdirSync(out, { recursive: true })
const icons = [
  ["icon-192.png", 192, { rounded: true, scale: 1 }],
  ["icon-512.png", 512, { rounded: true, scale: 1 }],
  ["icon-maskable-512.png", 512, { rounded: false, scale: 0.78 }],
  ["apple-touch-icon.png", 180, { rounded: false, scale: 0.9 }],
]
for (const [name, size, options] of icons)
  writeFileSync(join(out, name), render(size, options))
console.log(`wrote ${icons.length} icons to public/icons`)

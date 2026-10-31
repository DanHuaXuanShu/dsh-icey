/**
 * lib/png.mjs —— 纯 JS PNG 编码 + 像素工具（不依赖 sharp / canvas / 任何原生模块）
 * ============================================================================
 * 为什么自己写：agent 看画面要 PNG（attachments 只收 png/jpeg/webp/gif），
 * 而插件包里不能塞原生依赖（profile 是 autoInstallPeers:false，装不上）。
 * Node 自带 zlib，编码 PNG 只要 IHDR + IDAT + IEND 三个 chunk，六十行就够。
 *
 * 另外提供抓帧之后的必要加工：BGRA→RGBA、盒式缩放、裁剪、帧哈希、像素差。
 * ============================================================================
 */
import { deflateSync } from 'node:zlib'

/* ---------- CRC32（PNG 每个 chunk 都要） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  // CRC 覆盖 type + data
  const span = Buffer.concat([head.subarray(4, 8), data])
  crc.writeUInt32BE(crc32(span), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * RGBA8 → PNG
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba 长度必须是 width*height*4
 * @param {{ level?: number }} [opts]
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba, opts = {}) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: 期望 ${width * height * 4} 字节 RGBA，拿到 ${rgba.length}`)
  }
  const stride = width * 4
  // 每行前面加一个 filter 字节（0 = None）。图像是屏幕截图，用 None 足够，压缩率也不差。
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1)
    raw[at] = 0
    if (Buffer.isBuffer(rgba)) rgba.copy(raw, at + 1, y * stride, (y + 1) * stride)
    else raw.set(rgba.subarray(y * stride, (y + 1) * stride), at + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type: RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  const idat = deflateSync(raw, { level: opts.level ?? 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------- 像素加工 ---------- */

/** GDI 的 GetDIBits 给的是 BGRA（top-down），浏览器 canvas 要 RGBA */
export function bgraToRgba(bgra) {
  const out = Buffer.allocUnsafe(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]
    out[i + 1] = bgra[i + 1]
    out[i + 2] = bgra[i]
    out[i + 3] = 255 // 游戏画面没有透明，强制不透明，省得 canvas 叠出黑底
  }
  return out
}

/**
 * 盒式平均缩放（RGBA）。缩小用平均比最近邻好看很多，放大就退化成最近邻。
 */
export function resizeRgba(src, sw, sh, dw, dh) {
  if (dw === sw && dh === sh) return Buffer.from(src)
  const out = Buffer.allocUnsafe(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yRatio)
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((dy + 1) * yRatio)))
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xRatio)
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((dx + 1) * xRatio)))
      let r = 0, g = 0, b = 0, n = 0
      for (let y = y0; y < y1; y++) {
        let i = (y * sw + x0) * 4
        for (let x = x0; x < x1; x++, i += 4) {
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = (r / n) | 0
      out[o + 1] = (g / n) | 0
      out[o + 2] = (b / n) | 0
      out[o + 3] = 255
    }
  }
  return out
}

/** 裁剪一块矩形（坐标会夹在画面内） */
export function cropRgba(src, sw, sh, x, y, w, h) {
  // 🔴 2026-10-31：实机踩过 NaN。上层若传进 undefined（比如 ClientToScreen 没回填
  //    POINT），Math.round(undefined) => NaN 会一路传到 Buffer.allocUnsafe(NaN)，
  //    报 "size is out of range ... Received NaN"，整个抓帧直接失败。
  //    这里兜一层：非有限数就当成 0 / 全画面，绝不让 NaN 流下去。
  const fin = (v, d) => (Number.isFinite(v) ? v : d)
  x = fin(x, 0); y = fin(y, 0); w = fin(w, sw); h = fin(h, sh)
  // 🔴 2026-10-31：原来上界写的是 sw / sh，允许 cx == sw。
  //    这时 cw = max(1, min(0, w)) = 1 ⇒ 读 ((cy)*sw + sw + 1)*4，比缓冲区末尾还远。
  //    坐标完全越界时（比如传 999）直接 ERR_OUT_OF_RANGE 崩掉 —— selfcheck 抓到过。
  //    上界必须是 sw-1 / sh-1，保证 cx+cw <= sw、cy+ch <= sh。
  const cx = Math.max(0, Math.min(Math.max(0, sw - 1), Math.round(x)))
  const cy = Math.max(0, Math.min(Math.max(0, sh - 1), Math.round(y)))
  const cw = Math.max(1, Math.min(sw - cx, Math.round(w)))
  const ch = Math.max(1, Math.min(sh - cy, Math.round(h)))
  const out = Buffer.allocUnsafe(cw * ch * 4)
  for (let row = 0; row < ch; row++) {
    src.copy(out, row * cw * 4, ((cy + row) * sw + cx) * 4, ((cy + row) * sw + cx + cw) * 4)
  }
  return { data: out, width: cw, height: ch }
}

/**
 * 同 cropRgba，但作用在 BGRA 上（抓帧刚回来的原始缓冲）。
 *
 * 2026-10-31 加：窗口截图含标题栏，必须在**转 RGBA 之前**就裁掉，
 * 否则后面所有归一化坐标都得各自记得减去标题栏高度。
 * 在这里裁一次，下游全部按「纯游戏画面」算 —— 跨窗口尺寸一致。
 */
export function cropBgra(src, sw, sh, x, y, w, h) {
  return cropRgba(src, sw, sh, x, y, w, h)
}

/**
 * 缩放到「宽不超过 maxWidth」——保持比例，只缩不放
 * @returns {{data: Buffer, width: number, height: number}}
 */
export function fitWidth(rgba, w, h, maxWidth) {
  if (w <= maxWidth) return { data: Buffer.from(rgba), width: w, height: h }
  const nw = Math.max(1, Math.round(maxWidth))
  const nh = Math.max(1, Math.round((h * nw) / w))
  return { data: resizeRgba(rgba, w, h, nw, nh), width: nw, height: nh }
}

/**
 * 帧哈希：采样一小部分像素做 FNV-1a。用来判断「画面变没变」，比整帧比较快几十倍。
 */
export function frameHash(rgba) {
  let h = 0x811c9dc5
  const step = Math.max(4, (rgba.length >> 12) & ~3) // 大约取 4096 个采样点
  for (let i = 0; i < rgba.length; i += step) {
    h ^= rgba[i]
    h = Math.imul(h, 0x01000193)
    h ^= rgba[i + 1]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 非纯黑像素占比：抓帧失败（全黑/全透明）时用来自检 */
export function nonBlackRatio(rgba) {
  let lit = 0, total = 0
  const step = Math.max(4, (rgba.length >> 14) & ~3)
  for (let i = 0; i < rgba.length; i += step) {
    total++
    if (rgba[i] > 8 || rgba[i + 1] > 8 || rgba[i + 2] > 8) lit++
  }
  return total ? lit / total : 0
}

/** 两帧的差异比例（采样），0 = 完全一样 */
export function diffRatio(a, b) {
  const n = Math.min(a.length, b.length)
  let diff = 0, total = 0
  const step = Math.max(4, (n >> 14) & ~3)
  for (let i = 0; i < n; i += step) {
    total++
    if (Math.abs(a[i] - b[i]) > 10 || Math.abs(a[i + 1] - b[i + 1]) > 10 || Math.abs(a[i + 2] - b[i + 2]) > 10) diff++
  }
  return total ? diff / total : 0
}

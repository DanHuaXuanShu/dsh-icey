/**
 * lib/png-decode.mjs —— 最小 PNG 解码器（只支持我们自己 encodePng 生成的格式）
 *
 * 为什么需要它：旁观抓了 500 帧 PNG，要**离线**逐帧分析（宝箱检测调参、
 * 战斗画面统计），而不能一边开游戏一边实时抓。Node 自带 zlib，解 PNG 只要
 * 解析 IHDR + inflate(IDAT) + 反滤波。
 *
 * 支持：8bit、非隔行、颜色类型 2(RGB) / 6(RGBA)。
 * 不支持：调色板、16bit、隔行 —— 我们自己的编码器不会产出这些。
 */
import { inflateSync } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * @param {Buffer} buf PNG 文件内容
 * @returns {{width:number, height:number, rgba:Buffer}}
 */
export function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('不是 PNG')
  }
  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG：depth=${bitDepth} color=${colorType} interlace=${interlace}`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.allocUnsafe(width * height * 4)
  const prev = Buffer.alloc(stride)
  let p = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = Buffer.allocUnsafe(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff
      cur[x] = v
    }
    cur.copy(prev)
    for (let x = 0; x < width; x++) {
      const si = x * bpp
      const di = (y * width + x) * 4
      out[di] = cur[si]
      out[di + 1] = cur[si + 1]
      out[di + 2] = cur[si + 2]
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
  }
  return { width, height, rgba: out }
}

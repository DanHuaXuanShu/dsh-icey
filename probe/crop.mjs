// 通用裁剪放大：看细节用。
//
//   node probe/crop.mjs shots/timeline/f00110.png 0.62 0.70 0.85 0.88 8
//   node probe/crop.mjs shots/combat/c0001.png 0 0 1 1 1     # 只看分辨率
//
// 参数：文件  x0 y0 x1 y1  [倍数=6]  [输出路径]
// 坐标是 0~1 的比例，和 layout.mjs 里的框同一套口径。
// 输出默认 shots/crop/<原文件名>-x<倍数>.png
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'

const [file, ...rest] = process.argv.slice(2)
if (!file) {
  console.log('用法：node probe/crop.mjs <png> <x0> <y0> <x1> <y1> [倍数=6] [输出路径]')
  process.exit(1)
}
const box = {
  x0: Number(rest[0] ?? 0), y0: Number(rest[1] ?? 0),
  x1: Number(rest[2] ?? 1), y1: Number(rest[3] ?? 1),
}
const S = Math.max(1, Math.min(16, Number(rest[4] ?? 6)))

const img = decodePng(fs.readFileSync(file))
console.log(`源图 ${img.width}x${img.height}`)
if (box.x0 === 0 && box.y0 === 0 && box.x1 === 1 && box.y1 === 1 && S === 1) process.exit(0)

const xa = Math.max(0, Math.floor(box.x0 * img.width))
const ya = Math.max(0, Math.floor(box.y0 * img.height))
const xb = Math.min(img.width, Math.ceil(box.x1 * img.width))
const yb = Math.min(img.height, Math.ceil(box.y1 * img.height))
const cw = xb - xa, ch = yb - ya
if (cw <= 0 || ch <= 0) { console.log('框是空的'); process.exit(1) }

const W = cw * S, H = ch * S
const out = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const si = ((ya + Math.floor(y / S)) * img.width + (xa + Math.floor(x / S))) * 4
    const di = (y * W + x) * 4
    out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]
    out[di + 2] = img.rgba[si + 2]; out[di + 3] = 255
  }
}
const outPath = rest[5] || `shots/crop/${path.parse(file).name}-x${S}.png`
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, encodePng(W, H, out))
console.log(`裁 ${xa},${ya} → ${xb},${yb}（${cw}x${ch}）放大 ${S}x → ${outPath}  ${W}x${H}`)

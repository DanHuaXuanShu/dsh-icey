// 一次性探针：从整帧里裁出强化台那一块，用来目测精确边界 + 生成模板候选。
//   node probe/station-box.mjs [x0 y0 x1 y1]
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'

const SRC = 'probe/fixtures/station-fullframe.png'
const img = decodePng(fs.readFileSync(SRC))
const { width, height, rgba: data } = img
console.log(`源 ${SRC}  ${width}x${height}`)

const box = process.argv.length >= 6
  ? process.argv.slice(2, 6).map(Number)
  : [0.58, 0.42, 0.78, 0.72]

const xa = Math.floor(box[0] * width), xb = Math.min(width, Math.ceil(box[2] * width))
const ya = Math.floor(box[1] * height), yb = Math.min(height, Math.ceil(box[3] * height))
const cw = xb - xa, ch = yb - ya
const S = 3
const out = new Uint8Array(cw * S * ch * S * 4)
for (let y = 0; y < ch * S; y++) {
  for (let x = 0; x < cw * S; x++) {
    const si = ((ya + Math.floor(y / S)) * width + (xa + Math.floor(x / S))) * 4
    const di = (y * cw * S + x) * 4
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255
  }
}
fs.mkdirSync('shots/station', { recursive: true })
const p = 'shots/station/box.png'
fs.writeFileSync(p, encodePng(cw * S, ch * S, out))
console.log(`裁 ${xa},${ya} → ${xb},${yb}（${cw}x${ch}）放大 ${S}x → ${p}`)
console.log(`归一化: x ${(xa / width).toFixed(3)}~${(xb / width).toFixed(3)}  y ${(ya / height).toFixed(3)}~${(yb / height).toFixed(3)}`)

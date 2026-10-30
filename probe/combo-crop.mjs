// 一次性探针：把连击区（和它上方的血条/护盾）一起裁出来放大，直接看框有没有套错。
//
//   node probe/combo-crop.mjs shots/combat 0.075 0.205 0.235 0.295
//
// 不给框就用当前 COMBO_BOX。输出 shots/combo-crop/<原文件名>-crop.png（4 倍最近邻放大），
// 同时在控制台把「这框里的读数」和「上下各扩一圈的读数」都打出来 ——
// 前者是判定用的数，后者用来判断「框偏了没」。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'
import { isComboYellow, COMBO_BOX } from '../lib/games/icey/layout.mjs'

const dir = process.argv[2] || 'shots/combat'
const box = process.argv.length >= 7
  ? { x0: +process.argv[3], y0: +process.argv[4], x1: +process.argv[5], y1: +process.argv[6] }
  : COMBO_BOX

const ratioIn = (img, b) => {
  const { width, height, rgba } = img
  let n = 0, px = 0
  const xa = Math.max(0, Math.floor(b.x0 * width)), xb = Math.min(width, Math.ceil(b.x1 * width))
  const ya = Math.max(0, Math.floor(b.y0 * height)), yb = Math.min(height, Math.ceil(b.y1 * height))
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * width + x) * 4
      if (isComboYellow(rgba[i], rgba[i + 1], rgba[i + 2])) n++
      px++
    }
  }
  return px ? n / px : 0
}

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'))
let best = null
for (const f of files) {
  const img = decodePng(fs.readFileSync(path.join(dir, f)))
  const r = ratioIn(img, box)
  if (!best || r > best.r) best = { f, img, r }
}
if (!best) { console.log('没有 png'); process.exit(1) }

const { img, f, r } = best
console.log(`样本目录 ${dir}，共 ${files.length} 张`)
console.log(`当前框 ${JSON.stringify(box)} 读数最高的那张: ${f}  =  ${(r * 100).toFixed(3)}%`)
console.log(`图尺寸 ${img.width}x${img.height}`)

// 框上下左右各扩一圈，看信号是「集中在框里」还是「其实在框外」
const grow = (b, k) => ({
  x0: Math.max(0, b.x0 - k), y0: Math.max(0, b.y0 - k),
  x1: Math.min(1, b.x1 + k), y1: Math.min(1, b.y1 + k),
})
for (const k of [0, 0.02, 0.05, 0.10]) {
  const b = grow(box, k)
  console.log(`  扩 ${(k * 100).toFixed(0).padStart(2)}%  →  ${(ratioIn(img, b) * 100).toFixed(3).padStart(7)}%   ${JSON.stringify(b)}`)
}

// 往上扫：连击数字是不是其实在上方（框选低了）
console.log('\n=== 纵向窗口扫描（宽固定为框的 x 范围，高固定 0.05）===')
for (let y = 0.02; y < 0.40; y += 0.02) {
  const b = { x0: box.x0, x1: box.x1, y0: y, y1: y + 0.05 }
  const v = ratioIn(img, b)
  const bar = '#'.repeat(Math.min(60, Math.round(v * 1500)))
  console.log(`  y ${y.toFixed(2)}~${(y + 0.05).toFixed(2)}  ${(v * 100).toFixed(3).padStart(7)}%  ${bar}`)
}

// 裁一块够大的上下文：x 0~0.45, y 0~0.40，4 倍放大
const C = { x0: 0, y0: 0, x1: 0.45, y1: 0.40 }
const xa = Math.floor(C.x0 * img.width), xb = Math.ceil(C.x1 * img.width)
const ya = Math.floor(C.y0 * img.height), yb = Math.ceil(C.y1 * img.height)
const cw = xb - xa, ch = yb - ya
const S = 4
const out = new Uint8Array(cw * S * ch * S * 4)
for (let y = 0; y < ch * S; y++) {
  for (let x = 0; x < cw * S; x++) {
    const si = ((ya + Math.floor(y / S)) * img.width + (xa + Math.floor(x / S))) * 4
    const di = (y * cw * S + x) * 4
    out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]
    out[di + 2] = img.rgba[si + 2]; out[di + 3] = 255
  }
}
// 把框的四条边画成纯红，方便一眼看出框在哪
const drawRect = (b, col) => {
  const rx0 = Math.round((b.x0 - C.x0) * img.width * S), rx1 = Math.round((b.x1 - C.x0) * img.width * S)
  const ry0 = Math.round((b.y0 - C.y0) * img.height * S), ry1 = Math.round((b.y1 - C.y0) * img.height * S)
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= cw * S || y >= ch * S) return
    const di = (y * cw * S + x) * 4
    out[di] = col[0]; out[di + 1] = col[1]; out[di + 2] = col[2]; out[di + 3] = 255
  }
  for (let x = rx0; x <= rx1; x++) { put(x, ry0); put(x, ry1) }
  for (let y = ry0; y <= ry1; y++) { put(rx0, y); put(rx1, y) }
}
drawRect(box, [255, 0, 0])

fs.mkdirSync('shots/combo-crop', { recursive: true })
const outPath = `shots/combo-crop/${path.parse(f).name}-crop.png`
fs.writeFileSync(outPath, encodePng(cw * S, ch * S, out))
console.log(`\n已裁出 ${outPath}  （${cw * S}x${ch * S}，红框 = ${JSON.stringify(box)}）`)

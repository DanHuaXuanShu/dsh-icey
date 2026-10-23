/**
 * probe/make-glyph-template.mjs —— 生成「透明宝箱」的 ¥ 符号模板
 *
 * 用户展示（shots/hidden/h8.png）：隐藏房间里的宝箱是**半透明的**，
 * 箱体几乎看不见，只浮着一个青色大号 **¥** 符号（下方还有 ¥19 之类的数字）。
 * 所以除了「实心面板」型宝箱，还要单独认这个符号。
 *
 * 输出：lib/chest-template-glyph.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const src = process.argv[2] || 'shots/hidden/h8.png'
const img = decodePng(readFileSync(src))
const { width: W, height: H, rgba } = img
console.log(`源图 ${W}x${H}`)

// 符号包围盒（人工确认：左上那块浮着的青色 ¥）
const BW = { x0: 349, y0: 150, x1: 519, y1: 372 }
const bw = BW.x1 - BW.x0, bh = BW.y1 - BW.y0
console.log(`裁切 ${BW.x0},${BW.y0} → ${BW.x1},${BW.y1} = ${bw}x${bh}`)

let mn = 255, mx = 0, sum = 0, cnt = 0
for (let y = BW.y0; y < BW.y1; y++) {
  for (let x = BW.x0; x < BW.x1; x++) {
    const i = (y * W + x) * 4
    const L = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    if (L < mn) mn = L
    if (L > mx) mx = L
    sum += L; cnt++
  }
}
console.log(`区域亮度: ${mn.toFixed(0)} ~ ${mx.toFixed(0)}，均值 ${(sum / cnt).toFixed(1)}`)

const TW = 21, TH = 27
const tpl = new Uint8Array(TW * TH)
for (let ty = 0; ty < TH; ty++) {
  for (let tx = 0; tx < TW; tx++) {
    const sx0 = BW.x0 + Math.floor((tx * bw) / TW)
    const sx1 = BW.x0 + Math.max(Math.floor((tx * bw) / TW) + 1, Math.floor(((tx + 1) * bw) / TW))
    const sy0 = BW.y0 + Math.floor((ty * bh) / TH)
    const sy1 = BW.y0 + Math.max(Math.floor((ty * bh) / TH) + 1, Math.floor(((ty + 1) * bh) / TH))
    let s = 0, c = 0
    for (let y = sy0; y < Math.min(H, sy1); y++) {
      for (let x = sx0; x < Math.min(W, sx1); x++) {
        const i = (y * W + x) * 4
        s += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
        c++
      }
    }
    tpl[ty * TW + tx] = Math.round(s / Math.max(1, c))
  }
}

const arr = Array.from(tpl)
console.log(`模板 ${TW}x${TH} 灰度 ${Math.min(...arr)}~${Math.max(...arr)} 均值 ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}`)

writeFileSync('lib/chest-template-glyph.mjs', `/**
 * 「透明宝箱」模板（自动生成，来源 ${src}）
 *
 * 隐藏房间里的宝箱是半透明的：箱体几乎看不见，只浮着一个青色大号 ¥ 符号。
 * 生成脚本：probe/make-glyph-template.mjs
 */
export const CHEST_GLYPH_TEMPLATE = {
  width: ${TW},
  height: ${TH},
  frameWidth: 200,
  gray: Uint8Array.from(${JSON.stringify(arr)}),
}
`, 'utf8')
console.log('已写入 lib/chest-template-glyph.mjs')

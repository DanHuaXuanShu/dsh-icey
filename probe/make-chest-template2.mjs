/**
 * probe/make-chest-template2.mjs —— 重新生成宝箱模板（干净版）
 *
 * 真实宝箱在 shots/now-chest.png 里的位置（人工确认）：
 *   面板大致 x 826~945, y 500~700；把边框外扩一点 → x 817~988, y 497~741
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const src = 'shots/now-chest.png'
const img = decodePng(readFileSync(src))
const { width: W, height: H, rgba } = img
console.log(`源图 ${W}x${H}, rgba 长度 ${rgba.length}（应为 ${W * H * 4}）`)

const BW = { x0: 817, y0: 497, x1: 988, y1: 741 }
const bw = BW.x1 - BW.x0, bh = BW.y1 - BW.y0
console.log(`裁切 ${BW.x0},${BW.y0} → ${BW.x1},${BW.y1}  = ${bw}x${bh}`)

// 先看这块区域的实际亮度
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
console.log(`该区域亮度: 最小 ${mn.toFixed(0)} 最大 ${mx.toFixed(0)} 平均 ${(sum / cnt).toFixed(1)}`)

const TW = 21, TH = 30
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
console.log(`模板 ${TW}x${TH}  灰度范围 ${Math.min(...arr)}~${Math.max(...arr)}  均值 ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}`)
console.log('前 21 个:', arr.slice(0, 21).join(','))

const body = `/**
 * 宝箱模板（自动生成，来源 ${src}）
 *
 * 宝箱是固定美术资源：深色圆角面板 + 青色边框 + 大号青色 $。
 * 颜色阈值在复杂场景里误报率 59%，改用灰度模板做零均值归一化互相关（ZNCC）。
 * 重新生成：node probe/make-chest-template2.mjs
 */
export const CHEST_TEMPLATE = {
  width: ${TW},
  height: ${TH},
  /** 分析帧统一缩到这个宽度再匹配（此时宝箱约 21x30 像素，与模板 1:1） */
  frameWidth: 200,
  gray: Uint8Array.from(${JSON.stringify(arr)}),
}
`
writeFileSync('lib/chest-template.mjs', body, 'utf8')
console.log('已写入 lib/chest-template.mjs')

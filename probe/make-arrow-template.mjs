/**
 * probe/make-arrow-template.mjs —— 生成「方向箭头」灰度模板
 *
 * 真箭头位置（shots/arrow-now.png 人工确认）：
 *   空心三角，指向右，包围盒约 x 625~695, y 500~555（66x56）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const img = decodePng(readFileSync('shots/arrow-now.png'))
const { width: W, height: H, rgba } = img

const BW = { x0: 623, y0: 498, x1: 698, y1: 558 }
const bw = BW.x1 - BW.x0, bh = BW.y1 - BW.y0
console.log(`裁切 ${BW.x0},${BW.y0} → ${BW.x1},${BW.y1} = ${bw}x${bh}`)

const TW = 24, TH = 19
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
for (let ty = 0; ty < TH; ty++) {
  console.log('  ' + arr.slice(ty * TW, (ty + 1) * TW).map((v) => String(v).padStart(3)).join(''))
}

writeFileSync('lib/arrow-template.mjs', `/**
 * 方向箭头模板（自动生成，来源 shots/arrow-now.png）
 *
 * 游戏里的指引箭头：**暗白色细描边的空心三角**，指向右，约 4% 画面宽。
 * 生成脚本：probe/make-arrow-template.mjs
 */
export const ARROW_TEMPLATE = {
  width: ${TW},
  height: ${TH},
  gray: Uint8Array.from(${JSON.stringify(arr)}),
}
`, 'utf8')
console.log('已写入 lib/arrow-template.mjs')

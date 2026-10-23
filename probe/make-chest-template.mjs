/**
 * probe/make-chest-template.mjs —— 从真实宝箱帧里切出模板
 *
 * 宝箱是固定的美术资源（深色面板 + 青色圆角边框 + 大号青色 $），
 * 所以用模板匹配比任何颜色阈值都稳。
 *
 * 输出：lib/chest-template.mjs（16×24 灰度模板 + 尺寸元信息）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const src = process.argv[2] || 'shots/now-chest.png'
const img = decodePng(readFileSync(src))
const { width: W, height: H, rgba } = img
console.log(`源图 ${W}x${H}`)

// ① 在宝箱大致区域里找青色像素的包围盒
//    可用命令行指定框：node make-chest-template.mjs 图 x0 y0 x1 y1（比例）
const B = process.argv.slice(3).map(Number)
const bfx0 = B.length >= 4 ? B[0] : 0.505, bfy0 = B.length >= 4 ? B[1] : 0.50
const bfx1 = B.length >= 4 ? B[2] : 0.605, bfy1 = B.length >= 4 ? B[3] : 0.78
console.log(`搜索框: x ${bfx0}~${bfx1}  y ${bfy0}~${bfy1}`)
let minX = W, maxX = 0, minY = H, maxY = 0, n = 0
for (let y = Math.floor(H * bfy0); y < Math.floor(H * bfy1); y++) {
  for (let x = Math.floor(W * bfx0); x < Math.floor(W * bfx1); x++) {
    const i = (y * W + x) * 4
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    if (b > 150 && g > 130 && r < 140 && b - r > 60 && lum > 90) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      n++
    }
  }
}
console.log(`青色像素 ${n} 个，包围盒 x ${minX}~${maxX} (${maxX - minX}) y ${minY}~${maxY} (${maxY - minY})`)

// ② 稍微外扩（把深色面板也算进来）
const padX = Math.round((maxX - minX) * 0.22)
const padY = Math.round((maxY - minY) * 0.22)
const bx0 = Math.max(0, minX - padX), bx1 = Math.min(W, maxX + padX)
const by0 = Math.max(0, minY - padY), by1 = Math.min(H, maxY + padY)
const bw = bx1 - bx0, bh = by1 - by0
console.log(`裁切框 x ${bx0}~${bx1} y ${by0}~${by1} → ${bw}x${bh}  宽高比 ${(bw / bh).toFixed(2)}`)

// ③ 缩到 16×24 灰度
const TW = 21, TH = 30
const tpl = new Uint8Array(TW * TH)
for (let ty = 0; ty < TH; ty++) {
  for (let tx = 0; tx < TW; tx++) {
    const sx0 = bx0 + Math.floor((tx / TW) * bw)
    const sx1 = bx0 + Math.max(sx0 + 1, Math.floor(((tx + 1) / TW) * bw))
    const sy0 = by0 + Math.floor((ty / TH) * bh)
    const sy1 = by0 + Math.max(sy0 + 1, Math.floor(((ty + 1) / TH) * bh))
    let sum = 0, cnt = 0
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        const i = (y * W + x) * 4
        sum += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
        cnt++
      }
    }
    tpl[ty * TW + tx] = Math.round(sum / Math.max(1, cnt))
  }
}

const body = `/**
 * 宝箱模板（**自动生成**，来源：${src}）
 *
 * 宝箱是固定美术资源：深色圆角面板 + 青色边框 + 大号青色 $ 符号。
 * 颜色阈值在复杂场景里误报率 59%，所以改用 16×24 灰度模板做归一化互相关。
 * 生成脚本：probe/make-chest-template.mjs
 */
export const CHEST_TEMPLATE = {
  width: ${TW},
  height: ${TH},
  /** 分析帧统一缩到这个宽度再匹配，保证模板尺寸固定 */
  frameWidth: 200,  // 分析帧统一缩到 200 宽；此时宝箱约 21x30 像素，与模板 1:1
  gray: Uint8Array.from(${JSON.stringify([...tpl])}),
}
`
writeFileSync('lib/chest-template.mjs', body, 'utf8')
console.log('已写入 lib/chest-template.mjs')
console.log('模板灰度（16x24，0-255）:')
for (let ty = 0; ty < TH; ty++) {
  console.log('  ' + [...tpl.slice(ty * TW, (ty + 1) * TW)].map((v) => String(v).padStart(3)).join(''))
}

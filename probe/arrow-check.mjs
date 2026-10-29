// 一次性探针：拿一张「确实有黄箭头」的历史截图，跑一遍 findYellowArrow。
// 目的：分清楚到底是色域、阈值，还是通道顺序 —— 不用再打一场游戏等箭头出现。
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { findYellowArrow } from '../lib/ui/scan.mjs'
import { ENEMY_ARROW_MIN_SPAN } from '../lib/games/icey/layout.mjs'

const path = process.argv[2]
const img = decodePng(fs.readFileSync(path))
console.log('图尺寸:', img.width, 'x', img.height)
console.log('minSpan =', ENEMY_ARROW_MIN_SPAN)

const probe = findYellowArrow(img.rgba, img.width, img.height, {
  minSpan: ENEMY_ARROW_MIN_SPAN,
  diag: true,
})
console.log('\n=== 正式判定的结果 ===')
console.log('arrow =', JSON.stringify(probe.arrow))
console.log('yellowish =', probe.diag.yellowish, '个「像黄」像素')
console.log('sample RGB =', probe.diag.sample)
console.log('候选带:', JSON.stringify(probe.diag.bands, null, 1))

// 逐列摊开：哪些列有黄、每列多少个、ratio 多少 —— 看箭头到底卡在哪一条上
const { width, height, rgba } = img
const cols = new Uint16Array(width)
for (let y = 0; y < height; y++) {
  const base = y * width * 4
  for (let x = 0; x < width; x++) {
    const i = base + x * 4
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    if (r > 180 && g > 160 && b < 100 && r - b > 100 && g - b > 100) cols[x]++
  }
}
const hot = []
for (let x = 0; x < width; x++) {
  const ratio = cols[x] / height
  if (ratio >= 0.003) hot.push({ x, n: cols[x], ratio: +ratio.toFixed(4) })
}
console.log('\n=== 黄色像素集中在前 20 列（ratio >= 0.3%）===')
console.log(JSON.stringify(hot.slice(0, 20)))
console.log('这样的列一共', hot.length, '个；minRatio 要求 0.015，minSpan 要求 band 宽 0.025')

// 左上角连击区、左侧箭头区各数一次，方便对照画面
const countIn = (x0, y0, x1, y1) => {
  let n = 0
  for (let y = Math.floor(y0 * height); y < Math.min(height, y1 * height); y++) {
    for (let x = Math.floor(x0 * width); x < Math.min(width, x1 * width); x++) {
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (r > 180 && g > 160 && b < 100 && r - b > 100 && g - b > 100) n++
    }
  }
  return n
}
console.log('\n连击区(0.07~0.25, 0.14~0.30):', countIn(0.07, 0.14, 0.25, 0.30), '个黄像素')
console.log('左侧箭头区(0.02~0.15, 0.50~0.70):', countIn(0.02, 0.5, 0.15, 0.7), '个黄像素')

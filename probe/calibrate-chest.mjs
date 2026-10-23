/**
 * probe/calibrate-chest.mjs —— 用真实宝箱帧（shots/now-chest.png）校准检测参数
 *
 * 真实外观（2026-10-23 用户展示）：
 *   深色（近黑）面板 + 青色圆角边框 + 中间一个大号青色 $ 符号
 *   —— 不是「整片蓝色」，所以按“格子平均偏蓝”去判会全是 0。
 *
 * 正确特征 = **青色线条 + 极暗面板背景**的组合：
 *   ① 青色像素：B、G 高而 R 低
 *   ② 面板：局部亮度极低（近黑）
 *   ③ 青色像素被暗像素包住（不是天空里的一条亮线）
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const img = decodePng(readFileSync(process.argv[2] || 'shots/now-chest.png'))
const { width: W, height: H, rgba } = img
console.log(`帧: ${W}x${H}`)

/** 统计一块区域里：青色像素比例、暗像素比例、平均亮度 */
function stats(x0r, y0r, x1r, y1r) {
  const x0 = Math.floor(W * x0r), x1 = Math.floor(W * x1r)
  const y0 = Math.floor(H * y0r), y1 = Math.floor(H * y1r)
  let cyan = 0, dark = 0, n = 0, sumL = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      sumL += lum
      // 青色：B 和 G 都明显高于 R
      if (b > 140 && g > 120 && r < 130 && b - r > 60) cyan++
      if (lum < 55) dark++
      n++
    }
  }
  return {
    cyan: +(cyan / n * 100).toFixed(2),
    dark: +(dark / n * 100).toFixed(1),
    lum: +(sumL / n).toFixed(1),
  }
}

console.log('\n=== 宝箱区域（角色右侧那个面板，x 50~60%, y 50~78%）===')
console.log('  ', JSON.stringify(stats(0.50, 0.50, 0.60, 0.78)))
console.log('  更紧一点 x 52~59%, y 53~75%:', JSON.stringify(stats(0.52, 0.53, 0.59, 0.75)))

console.log('\n=== 对照：几块没有宝箱的地方 ===')
console.log('  左侧树林   x 05~15%, y 40~70%:', JSON.stringify(stats(0.05, 0.40, 0.15, 0.70)))
console.log('  中部地面   x 20~30%, y 75~85%:', JSON.stringify(stats(0.20, 0.75, 0.30, 0.85)))
console.log('  右侧远景   x 75~85%, y 35~55%:', JSON.stringify(stats(0.75, 0.35, 0.85, 0.55)))
console.log('  角色位置   x 44~52%, y 52~75%:', JSON.stringify(stats(0.44, 0.52, 0.52, 0.75)))

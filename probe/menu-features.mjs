/**
 * probe/menu-features.mjs —— 量「强化/暂停菜单」与「实机画面」的统计差异
 *
 * 背景：强化界面右侧有招式演示动画一直在动，我们的检测器把它当成"游戏在运行"，
 * 于是继续按键、卡在菜单里出不来。需要一条**菜单判据**。
 *
 * 候选特征：
 *   ① 整体暗度：菜单会把游戏画面压暗（大块死黑）
 *   ② 平均亮度
 *   ③ 亮区集中度：菜单里亮的东西集中在少数几块（列表文字 + 演示窗口）
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

function stats(path) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img
  const GRID = 16
  const cell = new Float32Array(GRID * GRID)
  const cellN = new Float32Array(GRID * GRID)
  let dark = 0, n = 0, sum = 0

  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      sum += lum; n++
      if (lum < 45) dark++
      const gx = Math.min(GRID - 1, Math.floor((x / W) * GRID))
      const gy = Math.min(GRID - 1, Math.floor((y / H) * GRID))
      cell[gy * GRID + gx] += lum
      cellN[gy * GRID + gx]++
    }
  }
  for (let k = 0; k < cell.length; k++) cell[k] = cellN[k] ? cell[k] / cellN[k] : 0

  // 亮格子占比（平均亮度 > 70 的格子）
  let brightCells = 0
  for (const v of cell) if (v > 70) brightCells++
  // 最亮格子 / 中位数（亮区集中度）
  const sorted = [...cell].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]

  return {
    file: path.split(/[\\/]/).pop(),
    w: W, h: H,
    meanLum: +(sum / n).toFixed(1),
    darkRatio: +(dark / n * 100).toFixed(1),
    brightCellPct: +(brightCells / cell.length * 100).toFixed(1),
    median: +median.toFixed(1),
    p90: +p90.toFixed(1),
    contrast: +(p90 - median).toFixed(1),
  }
}

const menu = ['shots/sk-0-opened.png', 'shots/p3-01.png', 'shots/p3-17.png', 'shots/up-4-upgrade.png', 'shots/mlv-1.png', 'shots/sys-0-menu.png']
const play = [
  'shots/arrow-now.png', 'shots/now-chest.png', 'shots/chest-hidden.png',
  'shots/watch/w0101.png', 'shots/combat/c0005.png', 'shots/combat/c0189.png',
  'shots/hidden/h8.png', 'shots/f140.png',
]

console.log('=== 菜单类 ===')
console.log('文件'.padEnd(20), 'mean   dark%  brightCell%  median  p90   contrast')
for (const p of menu) {
  try {
    const s = stats(p)
    console.log(s.file.padEnd(20), String(s.meanLum).padStart(6), String(s.darkRatio).padStart(6), String(s.brightCellPct).padStart(12), String(s.median).padStart(7), String(s.p90).padStart(6), String(s.contrast).padStart(8))
  } catch (e) { console.log(p, '失败:', e.message) }
}

console.log('\n=== 实机画面 ===')
console.log('文件'.padEnd(20), 'mean   dark%  brightCell%  median  p90   contrast')
for (const p of play) {
  try {
    const s = stats(p)
    console.log(s.file.padEnd(20), String(s.meanLum).padStart(6), String(s.darkRatio).padStart(6), String(s.brightCellPct).padStart(12), String(s.median).padStart(7), String(s.p90).padStart(6), String(s.contrast).padStart(8))
  } catch (e) { console.log(p, '失败:', e.message) }
}

// 量「战斗屏障」在最右边缘的实际亮度分布 —— 现有判据用 32 格网格取最右两列，
// 屏障只有约 1% 画面宽，平均下来被暗背景稀释，永远到不了门槛 85。
//   node probe/barrier-scan.mjs [图片]
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const CASES = process.argv[2] ? [process.argv[2]] : [
  'shots/ui-neg/barrier-174.png',        // 有屏障（角色贴右边缘，右侧青色光幕）
  'probe/fixtures/station-fullframe.png', // 无屏障（普通探索画面）
]

for (const f of CASES) {
  if (!fs.existsSync(f)) { console.log('缺', f); continue }
  const im = decodePng(fs.readFileSync(f))
  const { width, height, rgba } = im
  console.log(`\n=== ${f}  ${width}x${height} ===`)

  // 竖直方向只取中间一段（屏障是竖墙，不占满整屏高，但中段一定有）
  const y0 = Math.floor(height * 0.20), y1 = Math.ceil(height * 0.85)
  const N = 40
  const bandW = Math.max(1, Math.round(width * 0.0025))   // 每档 ≈ 宽度 0.25%
  console.log('从右往左扫（每档 = 宽度 0.25%），列平均亮度 / 青度(g+b-r):')
  const rows = []
  for (let k = 0; k < N; k++) {
    const x1 = width - Math.round(k * bandW)
    const x0 = Math.max(0, x1 - bandW)
    if (x1 <= x0) break
    let lum = 0, cyan = 0, n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
        lum += r * 0.299 + g * 0.587 + b * 0.114
        cyan += (g + b - r) / 2
        n++
      }
    }
    rows.push({
      fromRightPct: +((k * bandW / width) * 100).toFixed(2),
      lum: +(lum / n).toFixed(1),
      cyan: +(cyan / n).toFixed(1),
    })
  }
  // 只打印亮度或青度明显高的档
  const maxLum = Math.max(...rows.map((r) => r.lum))
  const maxCyan = Math.max(...rows.map((r) => r.cyan))
  for (const r of rows) {
    if (r.lum < 45 && r.cyan < 8) continue
    const bar = '#'.repeat(Math.min(50, Math.round(r.lum / 3)))
    console.log(`  右缘 ${String(r.fromRightPct).padStart(5)}%  亮度 ${String(r.lum).padStart(6)}  青度 ${String(r.cyan).padStart(6)}  ${bar}`)
  }
  console.log(`  峰值：亮度 ${maxLum.toFixed(1)} / 青度 ${maxCyan.toFixed(1)}`)

  // 现判据复算：32 格网格最右两列
  const GRID_COLS = 32, GRID_ROWS = 18
  const cellW = width / GRID_COLS
  const lumGrid = []
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    const row = []
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const xa = Math.floor(gx * cellW), xb = Math.min(width, Math.floor((gx + 1) * cellW))
      const ya = Math.floor((gy * height) / GRID_ROWS), yb = Math.min(height, Math.floor(((gy + 1) * height) / GRID_ROWS))
      let s = 0, n = 0
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
        const i = (y * width + x) * 4
        s += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
        n++
      }
      row.push(n ? s / n : 0)
    }
    lumGrid.push(row)
  }
  let eR = 0, barN = 0
  for (let gy = Math.floor(GRID_ROWS * 0.2); gy < Math.ceil(GRID_ROWS * 0.85); gy++) {
    eR += lumGrid[gy][GRID_COLS - 1] + lumGrid[gy][GRID_COLS - 2]
    barN++
  }
  eR /= barN * 2
  console.log(`  现判据的 edgeR（最右两列网格均值）= ${eR.toFixed(1)}，门槛 85 ⇒ ${eR > 85 ? '过' : '不过'}`)
}

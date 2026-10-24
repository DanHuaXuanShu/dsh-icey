/**
 * probe/scan-video.mjs —— 扫用户录屏抽出来的帧，找「处决提示」在哪一帧
 *
 * 判据不预设形状：只统计几类像素的**数量与集中区域**，让数据自己说话。
 *   暖色（黄/橙/金）  : r>140 && g>100 && r>b+40 && g>b+20
 *   亮白             : lum > 225
 *   饱和金           : r>165 && g>125 && b<115 && r-b>85 && g-b>55（现行判据的颜色）
 * 输出：每帧的三项计数，并按「暖色像素在画面里的集中度」排序，指出最可疑的帧。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const dir = process.argv[2] || 'shots/user-video'
const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
if (!files.length) { console.log('没有帧'); process.exit(1) }

const rows = []
for (let idx = 0; idx < files.length; idx++) {
  const f = files[idx]
  let img
  try { img = decodePng(readFileSync(`${dir}/${f}`)) } catch { continue }
  const { rgba, width: W, height: H } = img
  let warm = 0, bright = 0, gold = 0
  // 把画面切成 8x6 格，看暖色集中在哪一格（处决提示应该聚在一个小区域）
  const GX = 8, GY = 6
  const grid = new Array(GX * GY).fill(0)
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > 225) bright++
      if (r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55) gold++
      if (r > 140 && g > 100 && r > b + 40 && g > b + 20) {
        warm++
        const gi = Math.min(GY - 1, Math.floor((y / H) * GY)) * GX + Math.min(GX - 1, Math.floor((x / W) * GX))
        grid[gi]++
      }
    }
  }
  // 最集中的那一格（占全屏暖色的比例）—— 越集中越像是「一个小提示」而不是满地特效
  const maxCell = Math.max(...grid)
  const concentration = warm ? maxCell / warm : 0
  const cellIdx = grid.indexOf(maxCell)
  rows.push({
    file: f,
    at: +(idx / 10).toFixed(1), // 10fps 抽帧
    warm, bright, gold,
    concentration: +concentration.toFixed(2),
    cell: `${cellIdx % GX},${Math.floor(cellIdx / GX)}`,
    maxCell,
  })
}

console.log(`扫了 ${rows.length} 帧（10fps）\n`)

// 现行判据（饱和金）最多的几帧
console.log('=== 饱和金色像素最多的 10 帧（现行判据的颜色）===')
for (const r of [...rows].sort((a, b) => b.gold - a.gold).slice(0, 10)) {
  console.log(`  ${r.at.toString().padStart(5)}s  ${r.file}  金 ${String(r.gold).padStart(5)}  暖 ${String(r.warm).padStart(5)}  亮白 ${String(r.bright).padStart(5)}`)
}

// 暖色最集中的几帧（暖色 ≥300 且集中度 ≥0.25 才算「像一个小提示」）
console.log('\n=== 暖色最集中、且量够大的 12 帧（最像「一个成形的提示」）===')
const cands = rows.filter((r) => r.warm >= 300 && r.concentration >= 0.25)
  .sort((a, b) => (b.concentration * Math.min(b.warm, 2000)) - (a.concentration * Math.min(a.warm, 2000)))
  .slice(0, 12)
if (!cands.length) {
  console.log('  （没有满足条件的帧）')
} else {
  for (const r of cands) {
    console.log(`  ${r.at.toString().padStart(5)}s  ${r.file}  暖 ${String(r.warm).padStart(5)} 集中度 ${r.concentration} 格 ${r.cell}（${r.maxCell}）亮白 ${r.bright} 金 ${r.gold}`)
  }
}

// 亮白突增（头顶 L 可能是纯白小块）
console.log('\n=== 亮白像素最多的 10 帧（头顶 L 可能是纯白）===')
for (const r of [...rows].sort((a, b) => b.bright - a.bright).slice(0, 10)) {
  console.log(`  ${r.at.toString().padStart(5)}s  ${r.file}  亮白 ${String(r.bright).padStart(5)}  暖 ${r.warm}  金 ${r.gold}`)
}

// 每 5 秒的概览
console.log('\n=== 每 5 秒概览（暖色/金/亮白）===')
for (let i = 0; i < rows.length; i += 50) {
  const r = rows[i]
  console.log(`  ${r.at.toString().padStart(5)}s  暖 ${String(r.warm).padStart(5)}  金 ${String(r.gold).padStart(5)}  亮白 ${String(r.bright).padStart(5)}`)
}

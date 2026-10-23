/**
 * probe/menu-structure.mjs —— 找强化页面的**结构特征**
 *
 * 强化页面独有：
 *   ① 右侧一块**带亮边框的矩形演示窗**
 *   ② 左侧一列**整齐的文字行**（约 9 行，等间距）
 *   ③ 底部一行提示文字
 *
 * 这里量三个量：
 *   longH：长横向亮线数量（演示窗上下边框）
 *   listBands：左侧区域的文字行数量
 *   bottomLine：底部提示行是否有亮线
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

function analyze(path) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img
  const lum = (x, y) => {
    const i = (y * W + x) * 4
    return rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
  }

  // ① 每一行的亮像素数量，找「长横线」
  const rowBright = new Array(H).fill(0)
  for (let y = 0; y < H; y++) {
    let c = 0
    for (let x = 0; x < W; x += 2) if (lum(x, y) > 110) c++
    rowBright[y] = (c * 2) / W            // 占宽度比例
  }
  const lineRows = []
  for (let y = 0; y < H; y++) if (rowBright[y] > 0.22) lineRows.push(y)
  // 合并相邻行
  const groups = []
  let cur = null
  for (const y of lineRows) {
    if (cur && y - cur.end <= 3) cur.end = y
    else { cur = { start: y, end: y }; groups.push(cur) }
  }
  const longLines = groups.filter((g) => g.end - g.start <= 8)   // 细线

  // ② 左侧文字行：在 x 18%~42% 区域按行统计亮像素，找成组的行
  const x0 = Math.floor(W * 0.18), x1 = Math.floor(W * 0.42)
  const bandBright = new Array(H).fill(0)
  for (let y = 0; y < H; y++) {
    let c = 0
    for (let x = x0; x < x1; x++) if (lum(x, y) > 120) c++
    bandBright[y] = c / (x1 - x0)
  }
  let bands = 0
  let inBand = false
  for (let y = 0; y < H; y++) {
    const on = bandBright[y] > 0.06
    if (on && !inBand) { bands++; inBand = true }
    else if (!on && inBand) inBand = false
    if (!on) inBand = false
  }

  // ③ 底部提示：最下 12% 区域的亮像素比例
  let botBright = 0, botN = 0
  for (let y = Math.floor(H * 0.88); y < H; y++) {
    for (let x = 0; x < W; x += 2) { if (lum(x, y) > 110) botBright++; botN++ }
  }

  return {
    file: path.split(/[\\/]/).pop(),
    longLines: longLines.length,
    listBands: bands,
    bottomPct: +(botBright / botN * 100).toFixed(2),
  }
}

const menu = ['shots/sk-0-opened.png', 'shots/p3-01.png', 'shots/p3-08.png', 'shots/p3-17.png', 'shots/up-4-upgrade.png', 'shots/mlv-1.png']
const play = ['shots/arrow-now.png', 'shots/now-chest.png', 'shots/chest-hidden.png', 'shots/watch/w0101.png', 'shots/combat/c0005.png', 'shots/combat/c0189.png', 'shots/hidden/h8.png', 'shots/f140.png', 'shots/watch/w0254.png']

console.log('=== 菜单 ===')
console.log('文件'.padEnd(22), 'longLines listBands bottom%')
for (const p of menu) {
  try { const s = analyze(p); console.log(s.file.padEnd(22), String(s.longLines).padStart(9), String(s.listBands).padStart(9), String(s.bottomPct).padStart(7)) } catch (e) { console.log(p, e.message) }
}
console.log('\n=== 实机 ===')
console.log('文件'.padEnd(22), 'longLines listBands bottom%')
for (const p of play) {
  try { const s = analyze(p); console.log(s.file.padEnd(22), String(s.longLines).padStart(9), String(s.listBands).padStart(9), String(s.bottomPct).padStart(7)) } catch (e) { console.log(p, e.message) }
}

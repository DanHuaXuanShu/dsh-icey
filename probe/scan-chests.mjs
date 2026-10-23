/**
 * probe/scan-chests.mjs —— 离线扫旁观帧，找「蓝色小块 + 附近金黄色钱符号」
 *
 * 用户描述的宝箱特征：蓝色、有时半透明、中间有**钱的标识**（金色 $）。
 * 所以判据是组合的：
 *   ① 偏蓝的连通小块（排除大片蓝色天空/特效）
 *   ② 附近有**金黄色**像素（钱符号）—— 特效多是青白，不带金色
 *
 * 用法：node probe/scan-chests.mjs [目录] [topN]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng, cropRgba } from '../lib/png.mjs'

const dir = process.argv[2] || 'shots/watch'
const topN = Number(process.argv[3]) || 8
mkdirSync('shots/chest-scan', { recursive: true })

const COLS = 48, ROWS = 27

/** 一帧里找候选，返回 {blue, gold, x, y, cells} */
function scan(img) {
  const { width: W, height: H, rgba } = img
  const cw = Math.max(1, Math.floor(W / COLS))
  const ch = Math.max(1, Math.floor(H / ROWS))
  const blue = new Float32Array(COLS * ROWS)
  const gold = new Float32Array(COLS * ROWS)

  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      let sb = 0, sg = 0, n = 0
      const x0 = gx * cw, x1 = Math.min(W, x0 + cw)
      const y0 = gy * ch, y1 = Math.min(H, y0 + ch)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
          const bl = b - Math.max(r, g)
          if (bl > 0) sb += bl
          // 金黄：R 明显高、B 明显低
          if (r > 150 && g > 110 && b < 110 && r - b > 70) sg++
          n++
        }
      }
      const k = gy * COLS + gx
      blue[k] = n ? sb / n : 0
      gold[k] = n ? sg / n : 0
    }
  }

  // 蓝色候选：局部异常（比 8 邻域明显更蓝）
  const cand = new Uint8Array(COLS * ROWS)
  for (let gy = Math.floor(ROWS * 0.35); gy < ROWS; gy++) {
    for (let gx = 1; gx < COLS - 1; gx++) {
      const k = gy * COLS + gx
      if (blue[k] < 38) continue
      const nb = []
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = gx + dx, ny = gy + dy
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue
        nb.push(blue[ny * COLS + nx])
      }
      nb.sort((a, b) => a - b)
      const med = nb[Math.floor(nb.length / 2)]
      if (blue[k] - med >= 14) cand[k] = 1
    }
  }

  // 连通块 + 附近金色
  const seen = new Uint8Array(COLS * ROWS)
  let best = null
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const k0 = gy * COLS + gx
      if (!cand[k0] || seen[k0]) continue
      const stack = [k0]; seen[k0] = 1
      const cells = []
      while (stack.length) {
        const k = stack.pop(); cells.push(k)
        const cx = k % COLS, cy = Math.floor(k / COLS)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue
          const nk = ny * COLS + nx
          if (cand[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      if (cells.length < 2 || cells.length > 24) continue
      // 附近找金色
      let gsum = 0
      for (const k of cells) {
        const cx = k % COLS, cy = Math.floor(k / COLS)
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue
          gsum += gold[ny * COLS + nx]
        }
      }
      const score = gsum * 10 + cells.length
      const cy = Math.floor(cells[0] / COLS)
      if (!best || score > best.score) {
        best = {
          score: +score.toFixed(1),
          cells: cells.length,
          gold: +gsum.toFixed(3),
          x: +(gx / COLS).toFixed(3),
          y: +(cy / ROWS).toFixed(3),
          blue: +blue[k0].toFixed(1),
        }
      }
    }
  }
  return best
}

const files = readdirSync(dir).filter((n) => n.endsWith('.png')).sort()
console.log(`扫描 ${files.length} 帧…`)
const hits = []
for (const name of files) {
  let img
  try { img = decodePng(readFileSync(`${dir}/${name}`)) } catch { continue }
  const b = scan(img)
  if (!b) continue
  if (b.gold < 0.15) continue          // 没金色 ⇒ 大概率不是箱子
  hits.push({ name, ...b })
}

hits.sort((a, b) => b.score - a.score)
console.log(`\n有金色+蓝色组合的帧: ${hits.length} / ${files.length}`)
for (const h of hits.slice(0, 20)) {
  console.log(`  ${h.name}  score=${h.score}  cells=${h.cells}  gold=${h.gold}  x=${(h.x * 100).toFixed(0)}% y=${(h.y * 100).toFixed(0)}%`)
}

// 存前 N 帧的候选裁图
for (const h of hits.slice(0, topN)) {
  const img = decodePng(readFileSync(`${dir}/${h.name}`))
  const cx = h.x * img.width
  const half = img.width * 0.13
  const x0 = Math.max(0, Math.floor(cx - half))
  const x1 = Math.min(img.width, Math.floor(cx + half))
  const y0 = Math.floor(img.height * 0.30)
  const cut = cropRgba(img.rgba, img.width, img.height, x0, y0, x1 - x0, img.height - y0)
  writeFileSync(`shots/chest-scan/${h.name.replace('.png', '')}.png`, encodePng(cut.width, cut.height, cut.data))
}
console.log(`\n候选裁图 ${Math.min(topN, hits.length)} 张 → shots/chest-scan/`)

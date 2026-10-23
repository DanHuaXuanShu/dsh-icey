/**
 * probe/chest-features.mjs —— 对比「真宝箱」与「误报帧」的特征，找出真正能分开的判据
 *
 * 已知单帧判据（青色+暗）误报率 59%，说明还缺结构信息。
 * 这里把候选块的特征都打出来：
 *   cells 格数、bbox 宽高（格）、宽高比、青色亮度均值、边框青占比、中心青占比
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const COLS = 32, ROWS = 18

function features(path) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img
  const cw = Math.floor(W / COLS), ch = Math.floor(H / ROWS)
  const cyan = new Float32Array(COLS * ROWS)
  const dark = new Float32Array(COLS * ROWS)
  const lum = new Float32Array(COLS * ROWS)
  const cyanBright = new Float32Array(COLS * ROWS)

  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      let c = 0, d = 0, n = 0, sumL = 0, sumCB = 0, cn = 0
      const x0 = gx * cw, x1 = Math.min(W, x0 + cw)
      const y0 = gy * ch, y1 = Math.min(H, y0 + ch)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
          const L = r * 0.299 + g * 0.587 + b * 0.114
          sumL += L; n++
          if (L < 55) d++
          if (b > 140 && g > 120 && r < 130 && b - r > 60) { c++; sumCB += L; cn++ }
        }
      }
      const k = gy * COLS + gx
      cyan[k] = c / n
      dark[k] = d / n
      lum[k] = sumL / n
      cyanBright[k] = cn ? sumCB / cn : 0
    }
  }

  // 候选格
  const cand = new Uint8Array(COLS * ROWS)
  for (let gy = Math.floor(ROWS * 0.30); gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const k = gy * COLS + gx
      if (cyan[k] >= 0.03 && dark[k] >= 0.70 && lum[k] <= 60) cand[k] = 1
    }
  }

  // 找最大的连通块
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
      if (!best || cells.length > best.cells.length) best = { cells }
    }
  }
  if (!best) return { path, none: true }

  const xs = best.cells.map((k) => k % COLS)
  const ys = best.cells.map((k) => Math.floor(k / COLS))
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const wCells = maxX - minX + 1, hCells = maxY - minY + 1

  let csum = 0, bsum = 0
  for (const k of best.cells) { csum += cyan[k]; bsum += cyanBright[k] }
  return {
    path: path.split(/[\\/]/).pop(),
    cells: best.cells.length,
    wCells, hCells,
    aspect: +(wCells / hCells).toFixed(2),
    cyanAvg: +(csum / best.cells.length * 100).toFixed(1),
    cyanBrightAvg: +(bsum / best.cells.length).toFixed(0),
    x: +(((minX + maxX) / 2 + 0.5) / COLS).toFixed(2),
    y: +(((minY + maxY) / 2 + 0.5) / ROWS).toFixed(2),
  }
}

const files = process.argv.slice(2)
console.log('文件'.padEnd(22), 'cells  w  h  aspect  cyanAvg%  cyanBright  x     y')
for (const f of files) {
  try {
    const r = features(f)
    if (r.none) { console.log(f.padEnd(22), '（没有候选）'); continue }
    console.log(
      String(r.path).padEnd(22),
      String(r.cells).padStart(4),
      String(r.wCells).padStart(3),
      String(r.hCells).padStart(3),
      String(r.aspect).padStart(6),
      String(r.cyanAvg).padStart(9),
      String(r.cyanBrightAvg).padStart(10),
      String(r.x).padStart(5),
      String(r.y).padStart(5),
    )
  } catch (e) { console.log(f, '错误:', e.message) }
}

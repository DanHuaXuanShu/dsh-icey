/**
 * probe/debug-arrow.mjs —— 打印箭头检测内部各阶段
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { ARROW_TEMPLATE } from '../lib/arrow-template.mjs'

const img = decodePng(readFileSync(process.argv[2] || 'shots/arrow-now.png'))
const { width: W, height: H, rgba } = img

const mask = new Uint8Array(W * H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    if (lum < 70 || lum > 125) continue
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mx === 0) continue
    if ((mx - mn) / mx > 0.22) continue
    mask[y * W + x] = 1
  }
}

const seen = new Uint8Array(W * H)
const cands = []
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k0 = y * W + x
    if (!mask[k0] || seen[k0]) continue
    const stack = [k0]; seen[k0] = 1
    let area = 0, minX = x, maxX = x, minY = y, maxY = y
    while (stack.length) {
      const k = stack.pop(); area++
      const cx = k % W, cy = (k - cx) / W
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = cx + dx
        if (nx < 0 || nx >= W) continue
        const ny = cy + dy
        if (ny < 0 || ny >= H) continue
        const nk = ny * W + nx
        if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
      }
    }
    if (area < 40) continue
    cands.push({ area, minX, maxX, minY, maxY, bw: maxX - minX + 1, bh: maxY - minY + 1 })
  }
}
console.log('mask 候选块（按面积）:')
cands.sort((a, b) => b.area - a.area)

// 模板归一化
const t = Float32Array.from(ARROW_TEMPLATE.gray)
let tm = 0; for (const v of t) tm += v; tm /= t.length
let tv = 0; for (const v of t) tv += (v - tm) ** 2
const tstd = Math.sqrt(tv / t.length) || 1
const tnorm = new Float32Array(t.length)
for (let i = 0; i < t.length; i++) tnorm[i] = (t[i] - tm) / tstd

function corrOf(c) {
  const TW = ARROW_TEMPLATE.width, TH = ARROW_TEMPLATE.height
  const pad = 2
  const x0 = Math.max(0, c.minX - pad), y0 = Math.max(0, c.minY - pad)
  const x1 = Math.min(W - 1, c.maxX + pad), y1 = Math.min(H - 1, c.maxY + pad)
  const g = new Float32Array(TW * TH)
  for (let ty = 0; ty < TH; ty++) {
    const sy = Math.min(H - 1, y0 + Math.floor((ty * (y1 - y0)) / TH))
    for (let tx = 0; tx < TW; tx++) {
      const sx = Math.min(W - 1, x0 + Math.floor((tx * (x1 - x0)) / TW))
      const i = (sy * W + sx) * 4
      g[ty * TW + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    }
  }
  let m = 0; for (const v of g) m += v; m /= g.length
  let v2 = 0; for (const v of g) v2 += (v - m) ** 2
  const s = Math.sqrt(v2 / g.length) || 1
  let corr = 0
  for (let i = 0; i < g.length; i++) corr += ((g[i] - m) / s) * tnorm[i]
  return corr / g.length
}

for (const c of cands.slice(0, 15)) {
  const wR = c.bw / W
  const asp = c.bw / c.bh
  const fill = c.area / (c.bw * c.bh)
  const shapeOk = wR >= 0.03 && wR <= 0.07 && asp >= 1.0 && asp <= 1.8 && fill >= 0.12 && fill <= 0.55
  console.log(
    `  area=${String(c.area).padStart(5)} ${c.bw}x${c.bh} @(${c.minX},${c.minY}) x=${(c.minX / W * 100).toFixed(0)}%` +
    ` wR=${(wR * 100).toFixed(1)}% asp=${asp.toFixed(2)} fill=${fill.toFixed(2)}` +
    ` shapeOk=${shapeOk ? 'Y' : 'n'} corr=${corrOf(c).toFixed(3)}`,
  )
}

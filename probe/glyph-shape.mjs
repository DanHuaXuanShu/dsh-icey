/**
 * probe/glyph-shape.mjs —— 量透明宝箱的 ¥ 符号在像素层面的特征
 *
 * 模板匹配在这张图上区分不出来（背景全是青色线条），所以改用量纲特征：
 *   亮青色连通块的 面积 / 外接框 / 长宽比 / 填充率
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

function analyze(path) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img
  const mask = new Uint8Array(W * H)

  // 亮青色像素
  let total = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > 110 && b > 150 && g > 130 && r < 150 && b - r > 50) { mask[y * W + x] = 1; total++ }
    }
  }

  // 连通块（4 邻域，迭代栈）
  const seen = new Uint8Array(W * H)
  const comps = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k0 = y * W + x
      if (!mask[k0] || seen[k0]) continue
      const stack = [k0]; seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % W, cy = (k - cx) / W
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const nk = ny * W + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1
      if (area < 400) continue                    // 太小的不要
      comps.push({
        area,
        w: bw, h: bh,
        aspect: +(bw / bh).toFixed(2),
        fill: +(area / (bw * bh) * 100).toFixed(1),
        x: +(((minX + maxX) / 2) / W).toFixed(3),
        y: +(((minY + maxY) / 2) / H).toFixed(3),
      })
    }
  }
  comps.sort((a, b) => b.area - a.area)
  return { W, H, total, comps: comps.slice(0, 6) }
}

for (const p of process.argv.slice(2)) {
  const r = analyze(p)
  console.log(`\n=== ${p.split(/[\\/]/).pop()} (${r.W}x${r.H}) 亮青像素 ${r.total} ===`)
  console.log('  面积     宽   高   长宽比  填充%   x       y')
  for (const c of r.comps) {
    console.log(`  ${String(c.area).padStart(7)} ${String(c.w).padStart(4)} ${String(c.h).padStart(4)} ${String(c.aspect).padStart(7)} ${String(c.fill).padStart(6)} ${String(c.x).padStart(6)} ${String(c.y).padStart(6)}`)
  }
  if (!r.comps.length) console.log('  （没有 >=400 像素的亮青块）')
}

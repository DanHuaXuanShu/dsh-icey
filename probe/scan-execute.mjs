/**
 * probe/scan-execute.mjs —— 在一堆战斗帧里找「处决提示」（怪物身上的黄圈 + 头顶 L）
 *
 * 用户描述：怪物周围出现**黄圈**、头顶出现 **L** 时，按 L 处决。
 * 先在这些帧里找黄色环状物，命中就裁图存下来供人工确认。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng, cropRgba } from '../lib/png.mjs'

const dir = process.argv[2] || 'shots/combat'
mkdirSync('shots/execute-scan', { recursive: true })

function findYellow(img) {
  const { width: W, height: H, rgba } = img
  const mask = new Uint8Array(W * H)
  let n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      // 金黄：R、G 高，B 低
      if (r > 170 && g > 130 && b < 110 && r - b > 90 && g - b > 60) { mask[y * W + x] = 1; n++ }
    }
  }
  if (n < 30) return null
  const seen = new Uint8Array(W * H)
  const comps = []
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
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const nk = ny * W + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      if (area < 25) continue
      const bw = maxX - minX + 1, bh = maxY - minY + 1
      comps.push({
        area,
        w: bw, h: bh,
        aspect: +(bw / bh).toFixed(2),
        fill: +(area / (bw * bh)).toFixed(2),
        x: +(((minX + maxX) / 2) / W).toFixed(3),
        y: +(((minY + maxY) / 2) / H).toFixed(3),
        bbox: [minX, minY, maxX, maxY],
      })
    }
  }
  comps.sort((a, b) => b.area - a.area)
  return { total: n, comps: comps.slice(0, 4) }
}

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
const hits = []
for (const f of files) {
  let img
  try { img = decodePng(readFileSync(`${dir}/${f}`)) } catch { continue }
  const r = findYellow(img)
  if (!r) continue
  // 环状：长宽比接近 1、填充率偏低（空心）
  const ring = r.comps.find((c) => c.aspect > 0.6 && c.aspect < 1.7 && c.fill < 0.6 && c.area > 60)
  if (ring) hits.push({ f, ...ring, img })
}

hits.sort((a, b) => b.area - a.area)
console.log(`扫描 ${files.length} 帧，命中「黄色环状物」${hits.length} 帧`)
for (const h of hits.slice(0, 8)) {
  console.log(`  ${h.f}  area=${h.area} ${h.w}x${h.h} aspect=${h.aspect} fill=${h.fill} @ x=${(h.x * 100).toFixed(0)}% y=${(h.y * 100).toFixed(0)}%`)
}

for (const h of hits.slice(0, 6)) {
  const [x0, y0, x1, y1] = h.bbox
  const pad = Math.round((x1 - x0) * 0.8)
  const cx0 = Math.max(0, x0 - pad), cx1 = Math.min(h.img.width, x1 + pad)
  const cy0 = Math.max(0, y0 - pad * 2), cy1 = Math.min(h.img.height, y1 + pad)
  const cut = cropRgba(h.img.rgba, h.img.width, h.img.height, cx0, cy0, cx1 - cx0, cy1 - cy0)
  writeFileSync(`shots/execute-scan/${h.f}`, encodePng(cut.width, cut.height, cut.data))
}
console.log(`\n候选裁图 → shots/execute-scan/`)

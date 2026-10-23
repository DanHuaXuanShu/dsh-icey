/**
 * probe/arrow-features.mjs —— 量游戏里「方向箭头」的特征
 *
 * 已知在帧里见过两种：
 *   ① 右侧边缘的**黄色 ▶**（watch-mid.png 右侧）
 *   ② 底部的**白色/灰白 ►** 三角（f140.png 底部两个）
 *
 * 目标：拿到它们的颜色阈值、尺寸、出现位置，做成检测器。
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

function scan(path, label) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img

  // ① 黄色像素（R、G 高，B 低）
  const yellow = []
  // ② 亮白/灰白像素，只用来看底部三角
  const white = []
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (r > 140 && g > 120 && b < 100 && r - b > 80 && lum > 110) yellow.push([x, y])
      if (lum > 190 && Math.abs(r - b) < 25) white.push([x, y])
    }
  }

  console.log(`\n=== ${label} (${W}x${H}) ===`)
  console.log(`  黄色像素: ${yellow.length} 个`)
  if (yellow.length) {
    const xs = yellow.map((p) => p[0]), ys = yellow.map((p) => p[1])
    console.log(`    包围盒 x ${Math.min(...xs)}~${Math.max(...xs)}  y ${Math.min(...ys)}~${Math.max(...ys)}`)
    // 聚成几块
    const clusters = []
    for (const [x, y] of yellow) {
      let hit = null
      for (const c of clusters) {
        if (Math.abs(x - c.cx) < 60 && Math.abs(y - c.cy) < 60) { hit = c; break }
      }
      if (hit) { hit.n++; hit.cx = (hit.cx * (hit.n - 1) + x) / hit.n; hit.cy = (hit.cy * (hit.n - 1) + y) / hit.n
        hit.minX = Math.min(hit.minX, x); hit.maxX = Math.max(hit.maxX, x); hit.minY = Math.min(hit.minY, y); hit.maxY = Math.max(hit.maxY, y)
      } else clusters.push({ n: 1, cx: x, cy: y, minX: x, maxX: x, minY: y, maxY: y })
    }
    clusters.sort((a, b) => b.n - a.n)
    for (const c of clusters.slice(0, 5)) {
      console.log(`    块: ${c.n} 像素  中心(${c.cx.toFixed(0)},${c.cy.toFixed(0)})  尺寸 ${c.maxX - c.minX}x${c.maxY - c.minY}  位置 x=${(c.cx / W * 100).toFixed(0)}% y=${(c.cy / H * 100).toFixed(0)}%`)
    }
  }
  console.log(`  亮白像素: ${white.length} 个`)
}

for (const [p, l] of (process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => [p, p.split(/[\\/]/).pop()])
  : [['shots/watch-mid.png', 'watch-mid'], ['shots/f140.png', 'f140']])) {
  try { scan(p, l) } catch (e) { console.log(p, '失败:', e.message) }
}

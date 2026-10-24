/**
 * probe/find-keycap.mjs —— 在视频帧里定位「L 键帽」提示的真实参数
 *
 * 2026-10-24 从用户录屏里确认：处决提示 = **白色方形键帽图标 + 里面的黑色 L**，
 * 外加怪物身上一圈淡金光带。跟「⏎ 开启强化」是同一套键帽提示。
 * 之前 lib/execute-prompt.mjs 一直在找「金色环」，方向就是错的 ——
 * 金色那圈跟怪物糊在一起很难分，而白色键帽是干净的、特征极强。
 *
 * 这个脚本做两件事：
 *   ① 在指定帧里找「亮的方形、内部有暗块」的连通块，输出它的大小/长宽比/内部暗占比
 *   ② 把命中的区域裁出来存盘，方便肉眼核对是不是那个 L 键帽
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.log('用法: node probe/find-keycap.mjs <帧.png> [更多帧...]')
  process.exit(1)
}
mkdirSync('shots/keycap-crop', { recursive: true })

/** 亮块（键帽的白底） */
const isBright = (r, g, b) => {
  const lum = r * 0.299 + g * 0.587 + b * 0.114
  // 键帽是白/浅灰：亮、而且三通道接近（不是青色高光）
  const maxc = Math.max(r, g, b), minc = Math.min(r, g, b)
  return lum > 175 && (maxc - minc) < 60
}

function analyze(path) {
  const img = decodePng(readFileSync(path))
  const { rgba, width: W, height: H } = img
  const n = W * H
  const mask = new Uint8Array(n)
  let brightN = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isBright(rgba[i], rgba[i + 1], rgba[i + 2])) { mask[p] = 1; brightN++ }
  }
  const seen = new Uint8Array(n)
  const out = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k0 = y * W + x
      if (!mask[k0] || seen[k0]) continue
      const stack = [k0]
      seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % W, cy = (k - cx) / W
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const nk = ny * W + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1
      if (area < 200) continue
      if (bw < 12 || bh < 12) continue
      const fill = area / (bw * bh)
      // 键帽的边框是亮的、中间是黑 L ⇒ 填充率不会接近 1
      if (fill > 0.95) continue
      // 内部暗块占比（黑 L）
      let dark = 0, inner = 0
      for (let yy = minY + Math.round(bh * 0.15); yy <= maxY - Math.round(bh * 0.15); yy++) {
        for (let xx = minX + Math.round(bw * 0.15); xx <= maxX - Math.round(bw * 0.15); xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          inner++
          const i = (yy * W + xx) * 4
          const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
          if (lum < 90) dark++
        }
      }
      const darkRatio = inner ? dark / inner : 0
      out.push({
        minX, maxX, minY, maxY, area, bw, bh,
        wRatio: +(bw / W).toFixed(3),
        aspect: +(bw / bh).toFixed(2),
        fill: +fill.toFixed(2),
        darkRatio: +darkRatio.toFixed(2),
        cx: +(((minX + maxX) / 2) / W).toFixed(3),
        cy: +(((minY + maxY) / 2) / H).toFixed(3),
      })
    }
  }
  out.sort((a, b) => b.area - a.area)
  return { img, brightN, blocks: out.slice(0, 8) }
}

for (const path of targets) {
  const r = analyze(path)
  const name = path.split(/[\\/]/).pop().replace('.png', '')
  console.log(`\n=== ${name}（${r.img.width}x${r.img.height}，亮块像素 ${r.brightN}）===`)
  if (!r.blocks.length) { console.log('  没有符合「亮方形 + 内部暗」的块'); continue }
  for (const b of r.blocks) {
    console.log(`  面积 ${String(b.area).padStart(6)}  ${b.bw}x${b.bh}  宽占比 ${b.wRatio}  长宽比 ${b.aspect}  填充 ${b.fill}  内部暗 ${b.darkRatio}  位置 (${b.cx}, ${b.cy})`)
  }
  // 把最像键帽的（正方形、内部有暗块）裁出来看
  const cap = r.blocks.find((b) => b.aspect >= 0.8 && b.aspect <= 1.35 && b.darkRatio >= 0.15)
  if (cap) {
    const pad = 12
    const x0 = Math.max(0, cap.minX - pad), y0 = Math.max(0, cap.minY - pad)
    const x1 = Math.min(r.img.width - 1, cap.maxX + pad), y1 = Math.min(r.img.height - 1, cap.maxY + pad)
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1
    const buf = Buffer.alloc(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = ((y0 + y) * r.img.width + (x0 + x)) * 4
        const di = (y * cw + x) * 4
        r.img.rgba.copy(buf, di, si, si + 4)
      }
    }
    const p = `shots/keycap-crop/${name}-cap.png`
    writeFileSync(p, encodePng(cw, ch, buf))
    console.log(`  → 疑似键帽裁图 ${p}（${cw}x${ch}，放大看是不是 L）`)
  }
}

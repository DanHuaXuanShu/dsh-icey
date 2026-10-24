// probe/keycap-glyph.mjs —— 用检测器返回的精确 bbox，看键帽内白笔画的 3x3 分布
// 目的：区分 L（处决）和 U/E（其它键帽）—— 它们外框一模一样，只有字母不同。
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { findExecuteKeycap } from '../lib/execute-keycap.mjs'

const lum = (rgba, W, x, y) => {
  const i = (y * W + x) * 4
  return rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
}

function glyph(path) {
  const img = decodePng(readFileSync(path))
  // 需要 bbox：再跑一遍检测器并取中心
  const r = findExecuteKeycap(img.rgba, img.width, img.height)
  if (!r.hit) return { hit: false }
  // 用中心 + 返回的 bw/bh 重建 bbox
  const cx = r.x * img.width, cy = r.y * img.height
  const minX = Math.round(cx - r.bw / 2), maxX = Math.round(cx + r.bw / 2)
  const minY = Math.round(cy - r.bh / 2), maxY = Math.round(cy + r.bh / 2)
  const bw = maxX - minX + 1, bh = maxY - minY + 1
  const g = []
  for (let gy = 0; gy < 3; gy++) {
    const row = []
    for (let gx = 0; gx < 3; gx++) {
      let w = 0, n = 0
      for (let y = minY + Math.round((gy * bh) / 3); y < minY + Math.round(((gy + 1) * bh) / 3); y++) {
        for (let x = minX + Math.round((gx * bw) / 3); x < minX + Math.round(((gx + 1) * bw) / 3); x++) {
          n++
          if (lum(img.rgba, img.width, x, y) > 185) w++
        }
      }
      row.push(n ? +(w / n).toFixed(2) : 0)
    }
    g.push(row)
  }
  return { hit: true, bbox: `${bw}x${bh}`, g, whiteRatio: r.whiteRatio, score: r.score }
}

const T = 'shots/user-video/'
const samples = [
  ['f0650', 'L 处决（已知）'],
  ['f0670', 'L 处决（已知）'],
  ['f0080', 'U 追猎（已知）'],
  ['f0290', '19-20s 段（待判）'],
  ['f0240', '22-25s 段（待判）'],
  ['f0305', '29-31s 段（待判）'],
  ['f0585', '58-60s 段（待判）'],
  ['f0660', '63-69s 段（待判）'],
]
for (const [name, label] of samples) {
  let r
  try { r = glyph(T + name + '.png') } catch { continue }
  if (!r.hit) { console.log(`\n${name} ${label}: 没检测到键帽`); continue }
  console.log(`\n${name} ${label}  bbox ${r.bbox}  白 ${r.whiteRatio}  score ${r.score}`)
  console.log('   左上=%s 中上=%s 右上=%s', r.g[0][0], r.g[0][1], r.g[0][2])
  console.log('   左中=%s 中中=%s 右中=%s', r.g[1][0], r.g[1][1], r.g[1][2])
  console.log('   左下=%s 中下=%s 右下=%s', r.g[2][0], r.g[2][1], r.g[2][2])
}

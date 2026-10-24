/**
 * probe/track-hero.mjs —— 在一组连拍帧里追踪角色（青色能量像素的质心）
 *
 * 用途：连招验证时判断「角色有没有位移 / 位移多远」。
 * ICEY 的艾希身上有大量青蓝色能量光，是画面里最稳定的青色簇，用它当角色标记。
 *
 * 用法：node probe/track-hero.mjs shots/combo-verify/jo
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node probe/track-hero.mjs <帧目录>')
  process.exit(2)
}
const files = readdirSync(dir).filter((f) => /^f\d+.*\.png$/.test(f)).sort()

const rows = []
for (const f of files) {
  const img = decodePng(readFileSync(`${dir}/${f}`))
  const { width: W, height: H, rgba } = img
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      // 艾希的青色能量光：亮、偏青蓝
      if (lum > 110 && b > 150 && g > 120 && r < 160 && b - r > 45) {
        sx += x; sy += y; n++
      }
    }
  }
  rows.push({ f, n, cx: n ? sx / n : null, cy: n ? sy / n : null, W })
}

const base = rows.find((r) => r.cx !== null)
if (!base) { console.log('没找到青色像素，无法追踪'); process.exit(1) }

console.log(`目录 ${dir}｜${rows.length} 帧｜画面宽 ${base.W}`)
console.log('帧         青色像素  质心x      相对基准位移')
for (const r of rows) {
  const dx = r.cx === null ? null : r.cx - base.cx
  const pct = dx === null ? null : (dx / r.W) * 100
  console.log(
    r.f.padEnd(12),
    String(r.n).padStart(7),
    (r.cx === null ? '   —  ' : r.cx.toFixed(0).padStart(6)),
    dx === null ? '   —' : `${dx > 0 ? '+' : ''}${dx.toFixed(0)}px (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`,
  )
}
const moved = rows.filter((r) => r.cx !== null).map((r) => r.cx - base.cx)
const maxDx = Math.max(...moved.map(Math.abs))
console.log(`\n最大位移 ${maxDx.toFixed(0)}px（画面宽 ${base.W} 的 ${((maxDx / base.W) * 100).toFixed(1)}%）`)

/**
 * probe/motion-bands.mjs —— 区分「走路（整屏平移）」和「战斗（局部特效）」
 *
 * 新战斗判据（motion ≥8%）的副作用：走路时画面差异也有 20~60%，
 * 会被误判成战斗 → 原地挥刀不走路。
 *
 * 假设：走路是整幅画面同步平移（上下两带都在变）；
 *       战斗时变化集中在角色所在的中下部，上部（天空/树）几乎不动。
 * 这里算两组连续帧的「下部/上部」变化比值来验证。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

function bandMotion(prev, cur, W, H, y0, y1) {
  let diff = 0, n = 0
  for (let y = Math.floor(H * y0); y < Math.floor(H * y1); y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4
      const d = Math.abs(prev[i] - cur[i]) + Math.abs(prev[i + 1] - cur[i + 1]) + Math.abs(prev[i + 2] - cur[i + 2])
      if (d > 24) diff++
      n++
    }
  }
  return n ? diff / n : 0
}

function series(dir, label) {
  const files = readdirSync(dir).filter((f) => /^f\d+.*\.png$/.test(f)).sort()
  let prev = null
  const rows = []
  for (const f of files) {
    const img = decodePng(readFileSync(`${dir}/${f}`))
    const { rgba, width: W, height: H } = img
    if (prev) {
      const top = bandMotion(prev.rgba, rgba, W, H, 0.08, 0.35)
      const bottom = bandMotion(prev.rgba, rgba, W, H, 0.45, 0.88)
      rows.push({ top, bottom, ratio: top > 0.001 ? bottom / top : (bottom > 0.001 ? 99 : 0) })
    }
    prev = { rgba, width: W, height: H }
  }
  const med = (k) => {
    const s = rows.map((r) => r[k]).sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] || 0
  }
  console.log(`\n=== ${label}（${rows.length} 对连续帧）===`)
  console.log(`  上部变化 中位 ${(med('top') * 100).toFixed(2)}%`)
  console.log(`  下部变化 中位 ${(med('bottom') * 100).toFixed(2)}%`)
  console.log(`  下/上 比值 中位 ${med('ratio').toFixed(2)}`)
  return { top: med('top'), bottom: med('bottom'), ratio: med('ratio') }
}

const combat = series('shots/combo-verify/jjiii', '战斗中（怪在身边）')
const idleMove = series('shots/combo-verify/jo', '空地 + 刺击闪位移')
const combo2 = series('shots/combo-verify/jiPs+j', '上挑+凝滞（战斗）')

console.log('\n结论判断：')
console.log(`  战斗中 下/上 = ${combat.ratio.toFixed(2)}；位移 下/上 = ${idleMove.ratio.toFixed(2)}`)
console.log(combat.ratio > idleMove.ratio * 1.5
  ? '  ✅ 假设成立：战斗的「下部/上部」比值明显更高，可用它区分'
  : '  ❌ 假设不成立：比值区分不开，得换别的信号')

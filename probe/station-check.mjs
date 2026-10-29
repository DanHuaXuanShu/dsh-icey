// 验证强化台模板匹配能不能分开正负样本。
//   node probe/station-check.mjs
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { matchStation } from '../lib/ui/station-match.mjs'

const cases = [
  ['probe/fixtures/station-fullframe.png', true, '整帧（弥城死镇 496 米，提示框写着「按 ⏎：开启强化」）'],
  ['probe/fixtures/station-negative.png', false, '整帧负样本（同一画面区域稍后，强化台不在视野里）'],
]
// 2026-10-29 更正：watch/w0006 与 w0008~w0012 里**有**强化台（迷城森林 404 米，画面右侧），
// 只是这些帧是在暂停菜单里拍的、整屏压暗 92%。一开始当负样本是标错了 ——
// 它们反而是最值钱的样本：跨分辨率（900x524 vs 1568x913）+ 跨亮度（压暗 92%）都能认出来。
// （w0008 已肉眼确认：画面右侧就是那台金色机器，提示框写着「按 ⏎：开启强化」。）
const POS_EXTRA = [
  'shots/watch/w0006.png', 'shots/watch/w0008.png', 'shots/watch/w0009.png',
  'shots/watch/w0010.png', 'shots/watch/w0011.png', 'shots/watch/w0012.png',
]
for (const p of POS_EXTRA) {
  if (fs.existsSync(p)) cases.push([p, true, '正样本（暂停菜单压暗 92%，跨分辨率）'])
}
// 再拿一批真实战斗帧当负样本（尺寸不同，顺便验证跨分辨率）
const negDirs = ['shots/combat', 'shots/watch']
for (const d of negDirs) {
  if (!fs.existsSync(d)) continue
  const files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png')).slice(0, 12)
  for (const f of files) {
    const full = `${d}/${f}`
    if (POS_EXTRA.includes(full)) continue   // 上面已经当正样本了，别再算负的
    cases.push([full, false, '战斗/探索帧负样本'])
  }
}

console.log('样本'.padEnd(46) + '分数'.padStart(8) + '  位置(x,y)')
let posMin = Infinity
let negMax = -Infinity
const t0 = Date.now()
for (const [p, isPos, note] of cases) {
  let r
  try {
    const img = decodePng(fs.readFileSync(p))
    const t = Date.now()
    r = matchStation(img.rgba, img.width, img.height)
    r.ms = Date.now() - t
  } catch (e) {
    console.log(`${p.padEnd(46)}  解码失败: ${e.message}`)
    continue
  }
  const tag = isPos ? 'P' : ' '
  console.log(
    `${(tag + ' ' + p).padEnd(46)}${r.score.toFixed(3).padStart(8)}  ` +
    (r.x === null ? '(没找到)' : `(${r.x.toFixed(3)}, ${r.y.toFixed(3)})`) +
    `  ${r.ms}ms  ${note}`,
  )
  if (isPos) posMin = Math.min(posMin, r.score)
  else negMax = Math.max(negMax, r.score)
}
console.log(`\n正样本最低 ${posMin.toFixed(3)} / 负样本最高 ${negMax.toFixed(3)}  ⇒ 间隔 ${(posMin - negMax).toFixed(3)}`)
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (posMin > negMax) {
  const mid = (posMin + negMax) / 2
  console.log(`可行阈值 ≈ ${mid.toFixed(3)}（落在两者中间），建议取 ${(Math.floor(mid * 100) / 100).toFixed(2)}`)
} else {
  console.log('❌ 分不开：正样本最低分不高于负样本最高分，这套模板/尺度不能直接用')
}

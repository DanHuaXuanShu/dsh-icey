/**
 * probe/battle-signal.mjs —— 找「在不在打架」的可靠判据（不依赖敌人血条）
 *
 * 背景：用户 2026-10-24 指出「大部分怪物没有血条」，所以不能靠敌人血条。
 * 现有判据是 hudKick（HUD 亮度跳动），但真机实测它多数时间不成立，
 * 导致打怪时按「平时」策略出招 —— 艾希因此被打死过一次。
 *
 * 这里把手上的三类帧分别统计几个信号，看哪个能分开：
 *   shots/combat/  战斗中的帧（593 张）
 *   shots/watch/   旁观混合（500 张）
 *   ↑ 非战斗的空地帧（几张明确的）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'

function stat(paths, label) {
  const rows = []
  let prev = null
  for (const p of paths) {
    let img
    try { img = decodePng(readFileSync(p)) } catch { continue }
    const a = analyzeFrame(img.rgba, img.width, img.height, prev)
    prev = { rgba: img.rgba, width: img.width, height: img.height, hud: a.hud }
    rows.push({ motion: a.motion || 0, vfx: a.vfx || 0, hudKick: a.hudKick || 0, hudBright: a.hudBright || 0 })
  }
  if (!rows.length) return null
  const q = (arr, f) => {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * f))]
  }
  const col = (k) => rows.map((r) => r[k])
  return {
    label, n: rows.length,
    motion: { p50: q(col('motion'), 0.5), p90: q(col('motion'), 0.9) },
    vfx: { p50: q(col('vfx'), 0.5), p90: q(col('vfx'), 0.9) },
    hudKick: { p50: q(col('hudKick'), 0.5), p90: q(col('hudKick'), 0.9) },
    hudBright: { p50: q(col('hudBright'), 0.5) },
  }
}

const sample = (dir, n) => {
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort() } catch { return [] }
  const step = Math.max(1, Math.floor(files.length / n))
  const out = []
  for (let i = 0; i < files.length; i += step) out.push(`${dir}/${files[i]}`)
  return out
}

const combat = stat(sample('shots/combat', 60), '战斗帧')
const watch = stat(sample('shots/watch', 60), '旁观帧')
const idle = stat([
  'shots/arrow-now.png', 'shots/now-chest.png', 'shots/boss-cam.png',
].filter(Boolean), '空地帧')

for (const s of [combat, watch, idle]) {
  if (!s) continue
  console.log(`\n=== ${s.label}（${s.n} 帧）===`)
  console.log(`  motion    中位 ${(s.motion.p50 * 100).toFixed(2)}%   90分位 ${(s.motion.p90 * 100).toFixed(2)}%`)
  console.log(`  vfx       中位 ${(s.vfx.p50 * 100).toFixed(2)}%   90分位 ${(s.vfx.p90 * 100).toFixed(2)}%`)
  console.log(`  hudKick   中位 ${(s.hudKick.p50 * 100).toFixed(2)}%   90分位 ${(s.hudKick.p90 * 100).toFixed(2)}%`)
  console.log(`  hudBright 中位 ${(s.hudBright.p50 * 100).toFixed(2)}%`)
}

/* 再算一个组合判据的命中率 */
const hitRate = (paths, fn) => {
  let prev = null, hit = 0, n = 0
  for (const p of paths) {
    let img
    try { img = decodePng(readFileSync(p)) } catch { continue }
    const a = analyzeFrame(img.rgba, img.width, img.height, prev)
    prev = { rgba: img.rgba, width: img.width, height: img.height, hud: a.hud }
    n++
    if (fn(a)) hit++
  }
  return n ? (hit / n) * 100 : 0
}

console.log('\n=== 候选判据命中率 ===')
const tests = [
  ['只看 hudKick ≥2%（现有）', (a) => (a.hudKick || 0) >= 0.02],
  ['vfx ≥3%', (a) => (a.vfx || 0) >= 0.03],
  ['motion ≥8%', (a) => (a.motion || 0) >= 0.08],
  ['motion ≥12%', (a) => (a.motion || 0) >= 0.12],
  ['hudKick≥2% 或 vfx≥3%', (a) => (a.hudKick || 0) >= 0.02 || (a.vfx || 0) >= 0.03],
  ['hudKick≥2% 或 vfx≥3% 或 motion≥12%', (a) => (a.hudKick || 0) >= 0.02 || (a.vfx || 0) >= 0.03 || (a.motion || 0) >= 0.12],
]
const combatPaths = sample('shots/combat', 60)
const watchPaths = sample('shots/watch', 60)
console.log('判据'.padEnd(40), '战斗帧'.padStart(8), '旁观帧'.padStart(8))
for (const [name, fn] of tests) {
  console.log(name.padEnd(40), (hitRate(combatPaths, fn).toFixed(0) + '%').padStart(8), (hitRate(watchPaths, fn).toFixed(0) + '%').padStart(8))
}

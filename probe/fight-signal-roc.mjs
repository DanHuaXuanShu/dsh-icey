// 「在战斗」判据的离线对照 —— 单帧能算的两个信号：连击黄框占比、战斗屏障。
//
//   node probe/fight-signal-roc.mjs
//
// ⚠️ 说清楚这份数据的性质，别过度解读：
//   1. `shots/combat` 与 `shots/watch` 是**按采集时段**分组的，不是逐帧人工标注的
//      「这一帧在战斗 / 不在战斗」。所以下面算出来的不是严格意义的 ROC，
//      而是「两个时段抽样集的信号分布」。真实标签需要实机采帧时打点。
//   2. `motion` / `hudKick` 是**帧间量**，而 shots 里是跳帧（相邻文件不是相邻时刻），
//      所以这份数据**无法**验证「用 motion 判战斗」那条建议，必须实机采连续帧。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame, analyzeEnvironment, COMBO_MIN } from '../lib/autoplay.mjs'

const GROUPS = [
  ['shots/combat', 'combat'],
  ['shots/watch', 'watch'],
]

function load(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => {
    try {
      const im = decodePng(fs.readFileSync(path.join(dir, f)))
      const m = analyzeFrame(im.rgba, im.width, im.height, null)
      const e = analyzeEnvironment(im.rgba, im.width, im.height)
      return { file: f, combo: m.combo ?? 0, barrier: e.barrier === true, edge: e.barrierEdge }
    } catch { return null }
  }).filter(Boolean)
}

const data = {}
for (const [dir, key] of GROUPS) data[key] = load(dir)
for (const k of Object.keys(data)) console.log(`${k}: n=${data[k].length}`)

const rate = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : 0)

console.log('\n=== 单信号：连击黄框 combo >= COMBO_MIN(' + COMBO_MIN + ') ===')
for (const k of Object.keys(data)) {
  console.log(`  ${k.padEnd(7)} 命中 ${(rate(data[k], (r) => r.combo >= COMBO_MIN) * 100).toFixed(1)}%`)
}

console.log('\n=== 单信号：战斗屏障 barrier ===')
for (const k of Object.keys(data)) {
  console.log(`  ${k.padEnd(7)} 命中 ${(rate(data[k], (r) => r.barrier) * 100).toFixed(1)}%  (青度中位 ${
    (() => { const v = data[k].map((r) => r.edge).sort((a, b) => a - b); return v.length ? v[v.length >> 1].toFixed(1) : '-' })() })`)
}

console.log('\n=== 融合：combo || barrier ===')
for (const k of Object.keys(data)) {
  console.log(`  ${k.padEnd(7)} 命中 ${(rate(data[k], (r) => r.combo >= COMBO_MIN || r.barrier) * 100).toFixed(1)}%`)
}

console.log('\n=== combo 阈值扫描（combat 命中率 / watch 命中率）===')
console.log('  阈值         combat      watch     差')
for (const t of [0.002, 0.004, 0.006, 0.008, 0.010, 0.015, 0.020]) {
  const c = rate(data.combat || [], (r) => r.combo >= t) * 100
  const w = rate(data.watch || [], (r) => r.combo >= t) * 100
  console.log(`  ${String(t).padEnd(9)} ${c.toFixed(1).padStart(7)}% ${w.toFixed(1).padStart(9)}% ${(c - w).toFixed(1).padStart(7)}`)
}

console.log('\n注：差值越大越好。若所有阈值下差值都≈13 个百分点，说明单个 combo 阈值')
console.log('    再怎么调也只能到这个分离度 —— 该换信号，不是调门限。')

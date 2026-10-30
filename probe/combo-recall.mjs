// 复算「连击黄框能否分开战斗/探索」——独立实现，用来核对一份外来分析里的数字。
//
//   node probe/combo-recall.mjs
//
// 要回答的问题：把 COMBO_BOX 的黄框占比当成「在战斗」的唯一信号，召回率有多少？
// 口径：直接调 analyzeFrame()，与运行时同一套代码，不另写一套。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame, COMBO_MIN } from '../lib/autoplay.mjs'

const GROUPS = [
  ['shots/combat', '战斗帧'],
  ['shots/watch', '观察帧（探索/菜单混合）'],
]

const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

for (const [dir, label] of GROUPS) {
  if (!fs.existsSync(dir)) { console.log(`跳过（不存在）：${dir}`); continue }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
  const vals = []
  for (const f of files) {
    try {
      const im = decodePng(fs.readFileSync(path.join(dir, f)))
      const r = analyzeFrame(im.rgba, im.width, im.height, null)
      if (typeof r.combo === 'number') vals.push(r.combo)
    } catch { /* 坏帧跳过 */ }
  }
  const over = vals.filter((v) => v >= COMBO_MIN).length
  console.log(`\n${label}  ${dir}  n=${vals.length}`)
  console.log(`  超过 COMBO_MIN=${COMBO_MIN}：${over} 帧 = ${((over / vals.length) * 100).toFixed(1)}%`)
  console.log(`  p50=${(pct(vals, 50) * 100).toFixed(3)}%  p75=${(pct(vals, 75) * 100).toFixed(3)}%` +
    `  p90=${(pct(vals, 90) * 100).toFixed(3)}%  max=${(Math.max(...vals) * 100).toFixed(3)}%`)
}

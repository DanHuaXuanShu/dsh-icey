/**
 * probe/analyze-combat.mjs —— 离线分析战斗观察数据，产出「打法结论」
 *
 * 输入：shots/combat/metrics.jsonl（每 500ms 一行）
 * 输出：
 *   · 挨打事件统计（掉血多快、掉血前一刻画面什么状态）
 *   · 「挨打前 1.5 秒」的 motion / bright 分布 → 反推需不需要提前闪避
 *   · 疑似倒地（掉血后画面几乎静止）的次数
 *   · 高强度战斗段落（连续剧烈运动）的时间段
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'shots/combat/metrics.jsonl'
const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
console.log(`样本 ${rows.length} 条，覆盖 ${rows[rows.length - 1].t}s\n`)

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const pct = (a, p) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

// ① 挨打事件：hudDrop 明显
const DAMAGE = 0.012
const hits = rows.filter((r) => r.hudDrop > DAMAGE)
console.log(`=== 挨打事件 ===`)
console.log(`  次数: ${hits.length}（平均每 ${(rows.length / Math.max(1, hits.length)).toFixed(1)} 个样本一次）`)
console.log(`  单次最大掉血: ${Math.max(0, ...hits.map((r) => r.hudDrop)).toFixed(3)}`)

// ② 挨打前 1.5 秒（3 个样本）的画面状态
const before = []
for (const h of hits) {
  const idx = rows.indexOf(h)
  const pre = rows.slice(Math.max(0, idx - 3), idx)
  if (pre.length) before.push({ motion: mean(pre.map((r) => r.motion || 0)), bright: mean(pre.map((r) => r.bright)) })
}
if (before.length) {
  console.log(`  挨打前 1.5 秒：motion 中位 ${pct(before.map((b) => b.motion), 0.5).toFixed(1)}%，bright 中位 ${pct(before.map((b) => b.bright), 0.5).toFixed(1)}%`)
}

// ③ 疑似倒地：掉血之后画面几乎不动
const down = []
for (const h of hits) {
  const idx = rows.indexOf(h)
  const after = rows.slice(idx, idx + 4)
  if (after.length >= 3 && mean(after.map((r) => r.motion || 0)) < 8) down.push(h.t)
}
console.log(`\n=== 疑似倒地/硬直 ===`)
console.log(`  ${down.length} 次（时间点：${down.slice(0, 12).map((t) => t + 's').join(', ')}${down.length > 12 ? '…' : ''}）`)

// ④ 高强度段落
const high = rows.filter((r) => (r.motion || 0) > 45)
console.log(`\n=== 高强度战斗 ===`)
console.log(`  剧烈运动样本: ${high.length} / ${rows.length}（${(high.length / rows.length * 100).toFixed(0)}%）`)
const segs = []
let start = null, last = null
for (const r of high) {
  if (start === null) start = r.t
  else if (r.t - last > 3) { segs.push([start, last]); start = r.t }
  last = r.t
}
if (start !== null) segs.push([start, last])
console.log(`  连续剧烈段落: ${segs.length} 段（最长 ${Math.max(0, ...segs.map(([a, b]) => b - a)).toFixed(1)}s）`)

// ⑤ 旁白出现频率（说明过场/剧情的节奏）
const sub = rows.filter((r) => r.subtitle > 0.5)
console.log(`\n=== 旁白 ===`)
console.log(`  有字幕的样本: ${sub.length}（${(sub.length / rows.length * 100).toFixed(0)}%）`)

// ⑥ 宝箱候选
const chest = rows.filter((r) => r.chest >= 2)
console.log(`\n=== 宝箱候选 ===`)
console.log(`  ${chest.length} 个样本命中：${chest.slice(0, 10).map((r) => r.t + 's(' + r.chest + '格)').join(', ')}`)

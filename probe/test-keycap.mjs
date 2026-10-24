// probe/test-keycap.mjs —— 用真样本帧验证 L 键帽检测器
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { findExecuteKeycap } from '../lib/execute-keycap.mjs'

const probe = (p) => {
  const img = decodePng(readFileSync(p))
  return findExecuteKeycap(img.rgba, img.width, img.height)
}
const T = 'shots/user-video/'
console.log('=== 真样本（应该命中）===')
for (const f of ['f0650', 'f0640', 'f0630', 'f0660', 'f0670', 'f0680', 'f0570', 'f0560']) {
  const r = probe(T + f + '.png')
  console.log(`  ${f}  ${r.hit ? `✅ x=${r.x} y=${r.y} score=${r.score} 白=${r.whiteRatio}` : '❌ 没命中'}`)
}
console.log('=== 对照（不该命中）===')
let fp = 0
const negs = ['f0010', 'f0100', 'f0200', 'f0300', 'f0400', 'f0450', 'f0500', 'f0700', 'f0720']
for (const f of negs) {
  const r = probe(T + f + '.png')
  if (r.hit) fp++
  console.log(`  ${f}  ${r.hit ? `⚠️ 误报 x=${r.x} y=${r.y} score=${r.score}` : '✅ 干净'}`)
}
console.log(`误报 ${fp} / ${negs.length}`)

console.log('\n=== 全片 729 帧扫一遍：命中分布 ===')
const hits = []
for (let i = 1; i <= 729; i++) {
  const name = `f${String(i).padStart(4, '0')}.png`
  let r
  try { r = probe(T + name) } catch { continue }
  if (r.hit) hits.push({ t: +((i - 1) / 10).toFixed(1), ...r })
}
console.log(`命中 ${hits.length} 帧`)
// 按时间聚成段
const segs = []
for (const h of hits) {
  const last = segs[segs.length - 1]
  if (last && h.t - last.end < 1.0) { last.end = h.t; last.n++ }
  else segs.push({ start: h.t, end: h.t, n: 1 })
}
console.log('命中时段：')
for (const s of segs) console.log(`  ${s.start.toFixed(1)}s ~ ${s.end.toFixed(1)}s（${s.n} 帧）`)

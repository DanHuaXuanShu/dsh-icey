import { pickWeighted, COMBO_WEIGHTS, COMBOS } from '../lib/autoplay.mjs'
const total = Object.values(COMBO_WEIGHTS).reduce((a, b) => a + b, 0)
console.log(`权重总和 = ${total}`)
console.log(`COMBOS 条数 = ${COMBOS.length}，权重表条数 = ${Object.keys(COMBO_WEIGHTS).length}`)
const noWeight = COMBOS.filter((k) => !(k in COMBO_WEIGHTS))
const notInList = Object.keys(COMBO_WEIGHTS).filter((k) => !COMBOS.includes(k))
console.log(`COMBOS 里没有权重的: ${noWeight.length ? noWeight.join(' / ') : '（无）'}`)
console.log(`权重表里有但不在 COMBOS 的: ${notInList.length ? notInList.join(' / ') : '（无）'}`)

// 10000 次分布
const N = 10000
const cnt = {}
for (let s = 0; s < N; s++) { const k = pickWeighted(COMBO_WEIGHTS, s); cnt[k] = (cnt[k] || 0) + 1 }
console.log(`\n=== ${N} 次抽取分布（期望 = 权重/${total}）===`)
for (const [k, w] of Object.entries(COMBO_WEIGHTS)) {
  const got = (cnt[k] || 0) / N * 100
  const want = w / total * 100
  const flag = Math.abs(got - want) > want * 0.25 ? '  ← 偏差大' : ''
  console.log(`  ${k.padEnd(12)} 权重${String(w).padStart(2)}  实测 ${got.toFixed(2)}%  期望 ${want.toFixed(2)}%${flag}`)
}
// 三条空中连段在前 40 次里出现几次
const air = ['k|ji', 'k|jjii', 'k|jjji']
for (const start of [0, 1, 100, 1000, 12345, 777777]) {
  let hits = 0
  for (let s = start; s < start + 40; s++) if (air.includes(pickWeighted(COMBO_WEIGHTS, s))) hits++
  console.log(`  起始种子 ${String(start).padStart(6)} → 前 40 次里三条空中连段出现 ${hits} 次`)
}


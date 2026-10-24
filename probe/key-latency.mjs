/**
 * probe/key-latency.mjs —— 量「按一次键」到底花多久
 *
 * 背景：verify-combo 里 5 个点按 + 1 次按住，设计约 540ms，实测 1834ms。
 * 如果单次 keydown/keyup 就有几百毫秒开销，那连段的实际节奏会被拉长 2~3 倍，
 * 游戏的连段窗口（通常 200~400ms）根本接不上 —— 这是必须先量清楚的事。
 */
import { NativeBackend } from '../lib/host.mjs'

const N = Number(process.argv[2]) || 20

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 300))

const down = []
const up = []
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint()
  const d = await nb.keydown('j')
  const t1 = process.hrtime.bigint()
  await new Promise((r) => setTimeout(r, 40))
  const t2 = process.hrtime.bigint()
  const u = await nb.keyup('j')
  const t3 = process.hrtime.bigint()
  if (!d.ok || !u.ok) { console.log('按键失败', d.error || u.error); break }
  down.push(Number(t1 - t0) / 1e6)
  up.push(Number(t3 - t2) / 1e6)
  await new Promise((r) => setTimeout(r, 60))
}

const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length
  return { avg: +avg.toFixed(1), min: +s[0].toFixed(1), med: +s[Math.floor(s.length / 2)].toFixed(1), max: +s[s.length - 1].toFixed(1) }
}

console.log(`样本 ${down.length} 次（每次：keydown → 等 40ms → keyup）`)
console.log(`keydown: 平均 ${stat(down).avg}ms  中位 ${stat(down).med}ms  最小 ${stat(down).min}ms  最大 ${stat(down).max}ms`)
console.log(`keyup  : 平均 ${stat(up).avg}ms  中位 ${stat(up).med}ms  最小 ${stat(up).min}ms  最大 ${stat(up).max}ms`)
const total = stat(down).avg + stat(up).avg
console.log(`⇒ 一个「点按」的固定开销约 ${total.toFixed(0)}ms（不含 hold 时长）`)
console.log(`⇒ 5 键连段的理论耗时 ≈ ${(5 * (total + 70)).toFixed(0)}ms`)

await nb.dispose()

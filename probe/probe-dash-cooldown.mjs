/**
 * probe/probe-dash-cooldown.mjs —— 冲刺 O 的冷却有多长
 *
 * 上一次测到：O 单独按 80ms → 移动 68px（14% 画面宽），
 * 但 220ms / 400ms 那两次 → 29px / 0px。
 * 怀疑是**冷却**（不是按住时长的问题），因为中间只隔了 700ms。
 * 这里固定按住 80ms（已证明够），只改间隔，看多久恢复。
 */
import { NativeBackend } from '../lib/host.mjs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async (maxWidth = 480) => {
  for (let k = 0; k < 4; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}
function horizontalShift(a, b, W, H, maxShift = 200) {
  const A = (x, y) => a[(y * W + x) * 4] + a[(y * W + x) * 4 + 1] + a[(y * W + x) * 4 + 2]
  const B = (x, y) => b[(y * W + x) * 4] + b[(y * W + x) * 4 + 1] + b[(y * W + x) * 4 + 2]
  let best = 0, bestScore = Infinity
  for (let dx = -maxShift; dx <= maxShift; dx += 1) {
    let sum = 0, n = 0
    for (let y = Math.floor(H * 0.30); y < Math.floor(H * 0.62); y += 3) {
      const xFrom = Math.max(0, -dx) + 4
      const xTo = Math.min(W, W - dx) - 4
      for (let x = xFrom; x < xTo; x += 3) {
        sum += Math.abs(A(x, y) - B(x + dx, y))
        n++
      }
    }
    if (!n) continue
    const score = sum / n
    if (score < bestScore) { bestScore = score; best = dx }
  }
  return best
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 400))

async function dashOnce() {
  const before = await grab()
  if (!before) return null
  await nb.keydown('o')
  await new Promise((r) => setTimeout(r, 80))
  await nb.keyup('o')
  await new Promise((r) => setTimeout(r, 400))
  const after = await grab()
  if (!after) return null
  return horizontalShift(before.data, after.data, before.width, before.height)
}

console.log('=== 冲刺 O（固定按住 80ms），只改间隔 ===')
for (const gap of [400, 700, 1000, 1500, 2000, 2500]) {
  await new Promise((r) => setTimeout(r, gap))
  const dx = await dashOnce()
  console.log(`  间隔 ${String(gap).padStart(4)}ms → 位移 ${dx === null ? '?' : String(Math.abs(dx)).padStart(4)} px（${dx === null ? '?' : (Math.abs(dx) / 480 * 100).toFixed(1)}%）${dx !== null && Math.abs(dx) < 10 ? '  ← 没动' : ''}`)
}

console.log('\n=== 连按 6 次、间隔 1200ms（看是否每次都有）===')
let okCount = 0
for (let i = 1; i <= 6; i++) {
  await new Promise((r) => setTimeout(r, 1200))
  const dx = await dashOnce()
  const moved = dx !== null && Math.abs(dx) > 10
  if (moved) okCount++
  console.log(`  第 ${i} 次 → ${dx === null ? '?' : String(Math.abs(dx)).padStart(4)} px  ${moved ? '✅ 有效' : '❌ 没动'}`)
}
console.log(`  1200ms 间隔下 6 次里有效 ${okCount} 次`)

await nb.releaseAll().catch(() => null)
await nb.dispose()

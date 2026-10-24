/**
 * probe/probe-jump.mjs —— 重测跳跃（上一次采样时机不可靠）
 *
 * 上一次结果自相矛盾：80ms 跳 46px，140/260/500ms 反而 0~4px。
 * 原因怀疑是：两次跳跃之间只等 600ms，角色还在落地硬直里；
 * 且「按完键才开始连拍」会漏掉上升段。
 * 这次改成：起跳瞬间就开始连拍、每次间隔 2 秒、记完整上升时间曲线。
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
const grab = async (maxWidth = 640) => {
  for (let k = 0; k < 4; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}

/** b 相对 a 在竖直方向的最佳偏移（角色升起 ⇒ 画面内容整体上移） */
function verticalShift(a, b, W, H) {
  const A = (x, y) => a[(y * W + x) * 4] + a[(y * W + x) * 4 + 1] + a[(y * W + x) * 4 + 2]
  const B = (x, y) => b[(y * W + x) * 4] + b[(y * W + x) * 4 + 1] + b[(y * W + x) * 4 + 2]
  let best = 0, bestScore = Infinity
  for (let dy = 0; dy <= 110; dy += 1) {
    let sum = 0, n = 0
    for (let y = Math.floor(H * 0.42); y < Math.floor(H * 0.82) - dy; y += 3) {
      for (let x = Math.floor(W * 0.30); x < Math.floor(W * 0.70); x += 3) {
        sum += Math.abs(A(x, y + dy) - B(x, y))
        n++
      }
    }
    if (!n) continue
    const score = sum / n
    if (score < bestScore) { bestScore = score; best = dy }
  }
  return best
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 400))

const base = await grab()
if (!base) { console.log('抓帧失败'); await nb.dispose(); process.exit(1) }
const W = base.width, H = base.height
console.log(`基准帧 ${W}x${H}\n`)

console.log('=== 跳跃：按住空格不同时长（每次间隔 2 秒，起跳瞬间开始连拍）===')
for (const ms of [60, 140, 300, 600]) {
  // 等落地、等静止
  await new Promise((r) => setTimeout(r, 1500))
  const before = await grab()
  if (!before) { console.log(`  按住 ${ms}ms  抓帧失败`); continue }

  // 按下后**立刻**开始连拍（不等松开）
  await nb.keydown('space')
  const t0 = Date.now()
  const curve = []
  let released = false
  while (Date.now() - t0 < 900) {
    if (!released && Date.now() - t0 >= ms) { await nb.keyup('space'); released = true }
    const c = await grab()
    if (!c) continue
    curve.push({ at: Date.now() - t0, dy: verticalShift(before.data, c.data, W, H) })
  }
  if (!released) await nb.keyup('space')
  const peak = curve.reduce((m, p) => (p.dy > m.dy ? p : m), { at: 0, dy: 0 })
  const trail = curve.map((p) => p.dy).join(',')
  console.log(`  按住 ${String(ms).padStart(3)}ms  峰值 ${String(peak.dy).padStart(3)} px @${String(peak.at).padStart(3)}ms   曲线: ${trail}`)
}

console.log('\n=== 对照：按住 D 500ms 的实际位移（确认 260ms 那档的问题）===')
for (const ms of [260, 400, 600]) {
  await new Promise((r) => setTimeout(r, 600))
  const before = await grab()
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 400))
  const after = await grab()
  if (!before || !after) continue
  // 水平位移：复用竖直那套思路，改成横向
  const A = (x, y) => before.data[(y * W + x) * 4] + before.data[(y * W + x) * 4 + 1] + before.data[(y * W + x) * 4 + 2]
  const B = (x, y) => after.data[(y * W + x) * 4] + after.data[(y * W + x) * 4 + 1] + after.data[(y * W + x) * 4 + 2]
  let best = 0, bestScore = Infinity
  for (let dx = 0; dx <= 140; dx += 1) {
    let sum = 0, n = 0
    for (let y = Math.floor(H * 0.30); y < Math.floor(H * 0.62); y += 3) {
      for (let x = Math.floor(W * 0.10); x < W - dx - 4; x += 3) {
        sum += Math.abs(A(x, y) - B(x + dx, y))
        n++
      }
    }
    if (!n) continue
    const score = sum / n
    if (score < bestScore) { bestScore = score; best = dx }
  }
  console.log(`  按住 ${String(ms).padStart(3)}ms  → 位移 ${String(best).padStart(3)} px（画面宽 ${(best / W * 100).toFixed(1)}%）`)
  // 走回来
  await nb.keydown('a')
  await new Promise((r) => setTimeout(r, ms + 100))
  await nb.keyup('a')
}

await nb.releaseAll().catch(() => null)
await nb.dispose()

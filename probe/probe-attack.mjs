/**
 * probe/probe-attack.mjs —— 实测短按能不能出招 / 冲刺有没有位移
 *
 * 要查的是这批凭空的数字：
 *   attack  120ms   —— 能出刀吗？出刀时画面变化多大？
 *   heavy   140/160 —— 能出重击吗？
 *   dash(O) 160-220 —— **关键**：O 是位移技能，会不会也吃「200ms 起步死区」？
 *   combo   每键 70  —— 按键这么短，游戏认不认？
 *
 * 方法：
 *   出招 ⇒ 量按键后 600ms 内的**画面变化峰值**（刀光/特效会让画面剧变）
 *   位移 ⇒ 量按键前后的**背景水平平移**（相机跟角色，背景反向移）
 */
import { NativeBackend } from '../lib/host.mjs'
import { diffRatio } from '../lib/png.mjs'

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

const tap = async (key, ms) => {
  await nb.keydown(key)
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup(key)
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 400))

/** 按一下 → 连拍 600ms，返回画面变化峰值 */
async function burstPeak(key, ms, holdBefore = 0) {
  const base = await grab()
  if (!base) return null
  if (holdBefore) { await nb.keydown(holdBefore); await new Promise((r) => setTimeout(r, 80)) }
  const t0 = Date.now()
  // 按住 ms 后松开（与连拍并行，模拟真实动作）
  void tap(key, ms)
  let peak = 0
  let prev = base
  while (Date.now() - t0 < 600) {
    const c = await grab()
    if (!c) continue
    const d = diffRatio(prev.data, c.data)
    if (d > peak) peak = d
    prev = c
  }
  if (holdBefore) await nb.keyup(holdBefore)
  await new Promise((r) => setTimeout(r, 500))
  return peak
}

/** 水平位移（背景平移量，双向搜索） */
function horizontalShift(a, b, W, H, maxShift = 160) {
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

async function shiftOf(key, ms) {
  const before = await grab()
  if (!before) return null
  await tap(key, ms)
  await new Promise((r) => setTimeout(r, 420))
  const after = await grab()
  if (!after) return null
  const dx = horizontalShift(before.data, after.data, before.width, before.height)
  return dx
}

// ─── ① 出招：画面变化峰值 ────────────────────────────
console.log('=== 出招（量按键后 600ms 的画面变化峰值）===')
console.log('键        按住    峰值变化')
for (const [label, key, ms] of [
  ['J 普攻', 'j', 60], ['J 普攻', 'j', 120], ['J 普攻', 'j', 200],
  ['I 重击', 'i', 80], ['I 重击', 'i', 140], ['I 重击', 'i', 220],
]) {
  const peak = await burstPeak(key, ms)
  console.log(`  ${label.padEnd(8)} ${String(ms).padStart(3)}ms  ${peak === null ? '抓帧失败' : (peak * 100).toFixed(1) + '%'}`)
}

// ─── ② 冲刺 O 的位移（关键：会不会吃 200ms 死区）──────
console.log('\n=== 冲刺 O：按住越久跑越远吗（关键看 160~220ms 有没有效果）===')
for (const ms of [80, 160, 220, 400]) {
  const dx = await shiftOf('o', ms)
  console.log(`  按住 ${String(ms).padStart(3)}ms  → 背景平移 ${String(dx).padStart(4)} px（${dx === null ? '?' : (Math.abs(dx) / 480 * 100).toFixed(1) + '%'})`)
  await new Promise((r) => setTimeout(r, 700))
}

// ─── ③ 方向+O（像人类那样先按方向再冲刺）──────────────
console.log('\n=== 按住 D 时点 O（冲刺通常需要方向）===')
for (const ms of [120, 220]) {
  const before = await grab()
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, 120))
  await tap('o', ms)
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 420))
  const after = await grab()
  if (before && after) {
    const dx = horizontalShift(before.data, after.data, before.width, before.height)
    console.log(`  D + O(${String(ms).padStart(3)}ms) → 背景平移 ${String(dx).padStart(4)} px（${(Math.abs(dx) / 480 * 100).toFixed(1)}%）`)
  }
  await new Promise((r) => setTimeout(r, 700))
}

await nb.releaseAll().catch(() => null)
await nb.dispose()

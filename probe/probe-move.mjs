/**
 * probe/probe-move.mjs —— 实测「按住方向键多久走多远」「按住空格多久跳多高」
 *
 * 要查的两个凭空的数字：
 *   退一步 260ms —— 够不够真的退开（解开碰撞体互顶）？
 *   跳     140ms —— 够不够起跳？ICEY 有没有「长按跳更高」？
 *
 * 定位方法：**背景水平平移量**。相机跟着角色走，背景往反方向平移，
 * 所以两帧之间的最佳水平偏移 = 角色移动了多少（不必认出角色长什么样）。
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
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

/**
 * 两帧之间的水平偏移（像素）。取画面中带（避开 HUD 和地面），
 * 对每个候选 dx 求重叠区平均绝对差，取最小者。
 */
function horizontalShift(a, b, W, H, y0, y1, maxShift = 120) {
  const A = (x, y) => a[(y * W + x) * 4] + a[(y * W + x) * 4 + 1] + a[(y * W + x) * 4 + 2]
  const B = (x, y) => b[(y * W + x) * 4] + b[(y * W + x) * 4 + 1] + b[(y * W + x) * 4 + 2]
  let best = 0, bestScore = Infinity
  const ys = []
  for (let y = Math.floor(H * y0); y < Math.floor(H * y1); y += 3) ys.push(y)
  for (let dx = -maxShift; dx <= maxShift; dx += 1) {
    let sum = 0, n = 0
    for (const y of ys) {
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
  return { dx: best, score: bestScore }
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 300))

const base = await grab()
if (!base) { console.log('抓帧失败'); await nb.dispose(); process.exit(1) }
const W = base.width, H = base.height
console.log(`基准帧 ${W}x${H}`)

/** 静止基线：连续两帧的偏移应该是 0 */
{
  const b2 = await grab()
  const r = horizontalShift(base.data, b2.data, W, H, 0.30, 0.62)
  console.log(`静止基线偏移 ${r.dx} px（应接近 0，score ${r.score.toFixed(1)}）`)
}

// ─── ① 按住 D 不同时长，量位移 ──────────────────────────
console.log('\n=== 走路：按住 D 多久走多远 ===')
let prev = base
for (const ms of [100, 200, 260, 400, 600]) {
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 300))
  const c = await grab()
  if (!c) { console.log(`  ${String(ms).padStart(4)}ms  抓帧失败`); continue }
  // 背景往左移 ⇒ dx 负数；取绝对值当位移
  const r = horizontalShift(prev.data, c.data, W, H, 0.30, 0.62)
  console.log(`  ${String(ms).padStart(4)}ms  背景平移 ${String(r.dx).padStart(4)} px  = 画面宽 ${(Math.abs(r.dx) / W * 100).toFixed(1)}%（score ${r.score.toFixed(1)}）`)
  prev = c
  // 走回原位
  await nb.keydown('a')
  await new Promise((r) => setTimeout(r, ms + 80))
  await nb.keyup('a')
  await new Promise((r) => setTimeout(r, 300))
  prev = (await grab()) || prev
}

// ─── ② 按住空格不同时长，量跳起高度 ──────────────────────
console.log('\n=== 跳跃：按住空格多久跳多高（看有没有长按变高）===')
/**
 * 垂直位移用**同一位置上下两帧的最佳垂直偏移**近似：
 * 角色跳起时相机不跟（或跟得少），画面下部的背景变化能反映高度差。
 * 更稳的做法是看「角色脚下的地面线」——这里先用帧差面积当粗略指标。
 */
function verticalRise(a, b, W, H) {
  // 取画面中下部，找 b 相对 a 在竖直方向的偏移（角色升起 ⇒ 该区域内容整体上移）
  const A = (x, y) => a[(y * W + x) * 4] + a[(y * W + x) * 4 + 1] + a[(y * W + x) * 4 + 2]
  const B = (x, y) => b[(y * W + x) * 4] + b[(y * W + x) * 4 + 1] + b[(y * W + x) * 4 + 2]
  let best = 0, bestScore = Infinity
  for (let dy = 0; dy <= 90; dy += 1) {
    let sum = 0, n = 0
    for (let y = Math.floor(H * 0.40); y < Math.floor(H * 0.80) - dy; y += 3) {
      for (let x = Math.floor(W * 0.30); x < Math.floor(W * 0.70); x += 3) {
        sum += Math.abs(A(x, y + dy) - B(x, y))
        n++
      }
    }
    if (!n) continue
    const score = sum / n
    if (score < bestScore) { bestScore = score; best = dy }
  }
  return { dy: best, score: bestScore }
}

for (const ms of [80, 140, 260, 500]) {
  const before = await grab()
  if (!before) continue
  await nb.keydown('space')
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup('space')
  let peak = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 650) {
    const c = await grab()
    if (!c) continue
    const r = verticalRise(before.data, c.data, W, H)
    if (r.dy > peak) peak = r.dy
  }
  console.log(`  按住 ${String(ms).padStart(3)}ms  竖直位移峰值 ${String(peak).padStart(3)} px（画面高 ${H} 的 ${(peak / H * 100).toFixed(1)}%）`)
  await new Promise((r) => setTimeout(r, 600))
}

await nb.releaseAll().catch(() => null)
await nb.dispose()

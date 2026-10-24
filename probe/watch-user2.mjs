/**
 * probe/watch-user2.mjs —— 用户自己玩，宽颜色 + 高帧率抓帧（**完全不碰键鼠**）
 *
 * 上一版（watch-user.mjs）抓了 150 秒、2299 帧，只存下 10 张候选，
 * 全是右下角的黄色 ▶ 箭头 —— 用户说「看到处决提示了」，说明**漏了**。
 * 漏的原因怀疑是颜色判据太窄：旧判据只认「金色」
 *   (r>165 && g>125 && b<115 && r-b>85 && g-b>55)
 * 而处决提示的黄可能偏淡/偏白/偏橙，落在这个盒子外面。
 *
 * 这一版：
 *   ① 抓帧降到 480 宽（约 40ms/帧 ≈ 25 帧/秒，比原来快）
 *   ② **不筛形状**，只按「暖色像素够多」存帧（暖色 = r>140 且 g>100 且 r>b+40）
 *   ③ 同时记录「亮白像素」数（头顶的 L 可能是纯白）
 *   ④ 每 0.6 秒最多存一张，避免刷爆磁盘
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 90
const dir = 'shots/user-watch2'
mkdirSync(dir, { recursive: true })

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
console.log(`在抓（宽颜色，480 宽，约 25 帧/秒）：${seconds} 秒。看到提示就喊一声。`)

const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async () => {
  for (let k = 0; k < 3; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 480 })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

/** 统计暖色/亮白/金色三类像素，并给出暖色像素的分布区域 */
function stats(rgba, W, H) {
  let warm = 0, bright = 0, gold = 0
  let sx = 0, sy = 0
  let minX = W, maxX = 0, minY = H, maxY = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > 225) bright++
      if (r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55) gold++
      // 宽暖色：偏黄/橙/金，不要求多饱和
      if (r > 140 && g > 100 && r > b + 40 && g > b + 20) {
        warm++; sx += x; sy += y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return {
    warm, bright, gold,
    cx: warm ? +((sx / warm) / W).toFixed(3) : null,
    cy: warm ? +((sy / warm) / H).toFixed(3) : null,
    bx: warm ? +(minX / W).toFixed(3) : null,
    ex: warm ? +(maxX / W).toFixed(3) : null,
    by: warm ? +(minY / H).toFixed(3) : null,
    ey: warm ? +(maxY / H).toFixed(3) : null,
  }
}

const t0 = Date.now()
let frames = 0
let saved = 0
let lastSaveAt = -99
let peakWarm = { warm: 0, at: 0 }
const timeline = []

while (Date.now() - t0 < seconds * 1000) {
  const c = await grab()
  if (!c) continue
  frames++
  const at = +((Date.now() - t0) / 1000).toFixed(1)
  const s = stats(c.data, c.width, c.height)
  if (s.warm > peakWarm.warm) peakWarm = { ...s, at }
  // 每 5 秒记一行，方便后面对时间
  if (timeline.length === 0 || at - timeline[timeline.length - 1].at >= 5) timeline.push({ at, ...s })

  // 暖色够多就存（不筛形状）
  if (s.warm >= 120 && at - lastSaveAt > 0.6) {
    lastSaveAt = at
    saved++
    const p = `${dir}/f-${String(saved).padStart(3, '0')}-t${String(Math.round(at)).padStart(3, '0')}s.png`
    writeFileSync(p, encodePng(c.width, c.height, c.data))
    console.log(`  ▫️ ${at}s → ${p.split('/').pop()}  暖 ${s.warm} 金 ${s.gold} 亮白 ${s.bright}  区域 x ${s.bx}~${s.ex} y ${s.by}~${s.ey}`)
  }
}

await nb.dispose()
console.log(`\n=== 结束：${frames} 帧（${(frames / seconds).toFixed(1)} 帧/秒），存 ${saved} 张 ===`)
console.log(`暖色峰值 ${peakWarm.warm} @ ${peakWarm.at}s（金 ${peakWarm.gold} 亮白 ${peakWarm.bright}）`)
console.log('\n每 5 秒的暖色/金色/亮白：')
for (const t of timeline) console.log(`  ${String(t.at).padStart(5)}s  暖 ${String(t.warm).padStart(4)}  金 ${String(t.gold).padStart(4)}  亮白 ${String(t.bright).padStart(4)}`)

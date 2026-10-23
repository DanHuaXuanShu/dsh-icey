/**
 * probe/watch-combat.mjs —— 长时间战斗观察（自适应抓帧）
 *
 * 目的：用户打一场长时间的仗，我从中学：
 *   · 打法节奏（什么时候接近、什么时候撤离）
 *   · 受伤前一刻画面有什么征兆（敌人抬手/红圈/闪光）
 *   · 破盾、倒地、起身的画面特征
 *
 * 策略：每 500ms 采一帧（480 宽，便宜），
 *   · 指标全部写进 JSONL（每帧一行，便于事后统计）
 *   · 只在「血量/护盾突变」「画面剧变」「出现金色」时存 PNG，控制磁盘
 *
 * 用法：node probe/watch-combat.mjs [秒数，默认 900]
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng, cropRgba } from '../lib/png.mjs'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { analyzeFrame, analyzeEnvironment } from '../lib/autoplay.mjs'

const seconds = Number(process.argv[2]) || 900
mkdirSync('shots/combat', { recursive: true })
const jsonl = 'shots/combat/metrics.jsonl'
writeFileSync(jsonl, '')

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY —— 先把游戏开起来'); await nb.dispose(); process.exit(1) }
console.log(`战斗观察开始：${seconds} 秒（每 500ms 采样，自适应存图）`)

const t0 = Date.now()
let prev = null
let i = 0
let saved = 0
let lastSaveAt = 0
let lastHud = null

/** 统计画面里「很亮的像素」比例 —— 特效/爆发的强度代理 */
function brightRatio(rgba) {
  let n = 0, c = 0
  for (let p = 0; p < rgba.length; p += 16) {
    const lum = rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114
    if (lum > 210) n++
    c++
  }
  return n / c
}

while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 500))
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  if (!c.ok) continue
  i++
  const a = analyzeFrame(c.data, c.width, c.height, prev)
  const env = analyzeEnvironment(c.data, c.width, c.height)
  const bright = brightRatio(c.data)
  prev = { rgba: c.data, width: c.width, height: c.height, hud: a.hud }

  const t = +((Date.now() - t0) / 1000).toFixed(1)
  const hudDrop = lastHud === null ? 0 : +(lastHud - a.hudBright).toFixed(3)
  lastHud = a.hudBright

  const row = {
    t, i,
    hud: +a.hudBright.toFixed(3),
    hudDrop,                                   // >0.01 多半是挨打了
    motion: a.motion === null ? null : +(a.motion * 100).toFixed(1),
    subtitle: +(a.subtitle * 100).toFixed(1),
    bright: +(bright * 100).toFixed(1),        // 画面高亮占比（特效强度）
    chest: env.chest, seam: +env.seam.toFixed(0),
  }
  appendFileSync(jsonl, JSON.stringify(row) + '\n')

  // 触发存图：明显掉血 / 画面剧变 / 特效爆发 / 有宝箱候选
  const interesting = (hudDrop > 0.012) || (a.motion !== null && a.motion > 0.55) || bright > 6 || env.chest >= 2
  const now = Date.now()
  if (interesting && now - lastSaveAt > 700) {
    lastSaveAt = now
    saved++
    writeFileSync(`shots/combat/c${String(saved).padStart(4, '0')}.png`,
      encodePng(c.width, c.height, c.data))
  }
  if (i % 120 === 0) console.log(`  ${t}s  采样 ${i}，存图 ${saved}`)
}

console.log(`\n完成：采样 ${i} 帧，存图 ${saved} 张 → shots/combat/`)
console.log(`指标：${jsonl}`)
await nb.dispose()

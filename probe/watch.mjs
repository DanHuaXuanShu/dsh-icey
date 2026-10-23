/**
 * probe/watch.mjs —— 旁观学习：用户自己玩的时候，定时抓帧存档
 *
 * 目的：
 *   ① 学习**宝箱**长什么样（用户说：蓝色、有时透明、中间有钱的标识）
 *   ② 学习**战斗**：位移/闪避/破盾/倒地的画面特征
 *
 * 只是抓帧存档 + 打指标，不做决策、不按键（绝不干扰用户操作）。
 *
 * 用法：node probe/watch.mjs [秒数，默认 180] [间隔毫秒，默认 1200]
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { analyzeFrame, analyzeEnvironment } from '../lib/autoplay.mjs'

const seconds = Number(process.argv[2]) || 180
const every = Number(process.argv[3]) || 1200

mkdirSync('shots/watch', { recursive: true })

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY —— 先把游戏开起来再跑这个'); await nb.dispose(); process.exit(1) }
console.log(`开始旁观 ${seconds} 秒（每 ${every}ms 一帧，只抓不按）`)

const t0 = Date.now()
let i = 0
let prev = null
const index = []

while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, every))
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 900 })
  if (!c.ok) continue
  i++
  const a = analyzeFrame(c.data, c.width, c.height, prev)
  const env = analyzeEnvironment(c.data, c.width, c.height)
  prev = { rgba: c.data, width: c.width, height: c.height, hud: a.hud }

  const name = `w${String(i).padStart(4, '0')}`
  writeFileSync(`shots/watch/${name}.png`, encodePng(c.width, c.height, c.data))
  index.push({
    name, t: +((Date.now() - t0) / 1000).toFixed(1),
    hud: +a.hudBright.toFixed(3), motion: a.motion === null ? null : +(a.motion * 100).toFixed(2),
    subtitle: +(a.subtitle * 100).toFixed(2),
    destructible: env.destructible, seam: Number(env.seam.toFixed(0)),
  })
  if (i % 20 === 0) console.log(`  已抓 ${i} 帧（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
}

writeFileSync('shots/watch/index.json', JSON.stringify(index, null, 1), 'utf8')
console.log(`完成：${i} 帧 → shots/watch/，索引 shots/watch/index.json`)
await nb.dispose()

/**
 * probe/hud-probe.mjs —— 量「游戏内」vs「菜单/标题」的 HUD 特征
 *
 * 目的：给策略找一个**能区分「在游戏里」和「在菜单」**的稳定信号。
 * 之前的教训：标题界面有飘雪动画，motion 一直在 1.5–2%，策略以为"画面在动"，
 * 于是一直走路/挥刀却从不按 Enter，永远进不了游戏。
 *
 * 用法：node probe/hud-probe.mjs [每种状态采几帧]
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const N = Number(process.argv[2]) || 3
const nb = new NativeBackend()
await nb.start()

const found = await nb.find('ICEY.exe')
if (!found.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(found.hwnd)

const measure = async (label) => {
  const rows = []
  for (let i = 0; i < N; i++) {
    const c = await nb.capture(found.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
    if (!c.ok) { console.log('  抓帧失败', c.error); return }
    const m = analyzeFrame(c.data, c.width, c.height, null)
    rows.push({ hud: +m.hud.toFixed(1), bright: +(m.hudBright * 100).toFixed(2) })
    await new Promise((r) => setTimeout(r, 300))
  }
  const avg = (k) => (rows.reduce((a, b) => a + b[k], 0) / rows.length).toFixed(2)
  console.log(`  ${label.padEnd(10)} hud 均值 ${avg('hud')}  bright% 均值 ${avg('bright')}   原始: ${JSON.stringify(rows)}`)
}

const shot = async (name) => {
  const c = await nb.capture(found.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
}

console.log('采集中（每 0.3 秒一帧）…')
await measure('游戏内')
await shot('hud-ingame')

// 暂停菜单 = 典型的「菜单态」
await nb.tap('Escape', 80)
await new Promise((r) => setTimeout(r, 1200))
await measure('暂停菜单')
await shot('hud-pause')

// 关掉菜单回到游戏
await nb.tap('Escape', 80)
await new Promise((r) => setTimeout(r, 1000))
await measure('回到游戏')

console.log('\n截图: shots/hud-ingame.png / shots/hud-pause.png')
await nb.dispose()

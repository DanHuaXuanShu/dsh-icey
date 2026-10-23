/**
 * probe/prompt-probe.mjs —— 测「互动提示框」信号
 *
 * 目的：分辨「能互动的门/机关」和「锁住的门/纯装饰」。
 * 假设：能互动时 ICEY 会浮出白字提示（「按 J: 开启强化」那种），那一带白色像素会明显变多。
 *
 * 做法：在当前位置、往左走回机器人（有提示框）、再走到门口（没提示框）三处各采几帧对比。
 * 用法：node probe/prompt-probe.mjs
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))

const sample = async (label, n = 3) => {
  const rows = []
  for (let i = 0; i < n; i++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
    if (!c.ok) { console.log('  抓帧失败'); return }
    const m = analyzeFrame(c.data, c.width, c.height, null)
    rows.push(+(m.promptBright * 100).toFixed(3))
    await new Promise((r) => setTimeout(r, 250))
  }
  const avg = rows.reduce((a, b) => a + b, 0) / rows.length
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  writeFileSync(`shots/prompt-${label}.png`, encodePng(c.width, c.height, c.data))
  console.log(`  ${label.padEnd(14)} promptBright 均值 ${avg.toFixed(3)}%  ${JSON.stringify(rows)}`)
  return avg
}

const walk = async (key, ms) => {
  await nb.keydown(key)
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup(key)
  await new Promise((r) => setTimeout(r, 400))
}

console.log('1) 当前位置（疑似门口，应该没有提示框）')
const atDoor = await sample('door')

console.log('2) 往左走 2.5 秒，回到机器人附近（应该有「按 J: 开启强化」提示）')
await walk('a', 2500)
const atRobot = await sample('robot')

console.log('3) 再往右走回门口')
await walk('d', 2500)
const backAtDoor = await sample('door2')

console.log('\n对照：')
console.log(`  门口 ${atDoor.toFixed(3)}% / ${backAtDoor.toFixed(3)}%   机器人附近 ${atRobot.toFixed(3)}%`)
console.log(`  → ${atRobot > (atDoor + backAtDoor) / 2 * 2 ? '提示框信号可分 ✅' : '差距不够，需要换区域或阈值 ⚠️'}`)
await nb.dispose()

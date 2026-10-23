/**
 * probe/open-upgrade.mjs —— 从标题界面进入游戏，走到强化台并打开招式升级界面
 *
 * 用法：node probe/open-upgrade.mjs [走左多少毫秒，默认 2600]
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const walkMs = Number(process.argv[2]) || 2600
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))

const shot = async (name, maxWidth = 960) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  return c
}
const tap = async (key, ms = 80) => { await nb.tap(key, ms); await new Promise((r) => setTimeout(r, 500)) }
const hold = async (key, ms) => {
  await nb.keydown(key)
  await new Promise((r) => setTimeout(r, ms))
  await nb.keyup(key)
  await new Promise((r) => setTimeout(r, 400))
}

console.log('1) 标题界面 → Enter 打开主菜单')
await shot('up-0-title')
await tap('Enter')
await shot('up-1-menu')
console.log('2) 再 Enter → 继续游戏')
await tap('Enter')
await new Promise((r) => setTimeout(r, 3000))
await shot('up-2-ingame')
console.log(`3) 往左走 ${walkMs}ms 到强化台`)
await hold('a', walkMs)
await shot('up-3-at-station')
console.log('4) 按 Enter 打开强化界面')
await tap('Enter')
await new Promise((r) => setTimeout(r, 1200))
await shot('up-4-upgrade', 1100)
console.log('截图: shots/up-0..up-4')
await nb.dispose()

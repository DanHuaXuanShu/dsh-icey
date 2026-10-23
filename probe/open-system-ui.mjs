/**
 * probe/open-system-ui.mjs —— 从暂停菜单进入「泛用型™系统接入界面」（招式强化界面）
 *
 * ⚠️ 暂停菜单第 2 项是「退出」（会丢档）！所以每移动一次都截图确认，
 *    绝不盲按 Enter。
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const shot = async (n) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 1100 })
  if (c.ok) writeFileSync(`shots/${n}.png`, encodePng(c.width, c.height, c.data))
  return c
}
const step = async (key) => { await nb.tap(key, 70); await new Promise((r) => setTimeout(r, 450)) }

console.log('当前画面（应停在暂停菜单）：')
await shot('sys-0-menu')

console.log('按 s 下移一格（到「退出」）—— 只截图，不按 Enter')
await step('s')
await shot('sys-1-down1')

console.log('再按 s 下移（到「回到泛用型系统接入界面」）')
await step('s')
await shot('sys-2-down2')

console.log('按 Enter 进入系统接入界面')
await step('Enter')
await new Promise((r) => setTimeout(r, 1500))
await shot('sys-3-entered')

console.log('截图: shots/sys-0..sys-3（请人工确认高亮在第三项）')
await nb.dispose()

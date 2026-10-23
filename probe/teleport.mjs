/**
 * probe/teleport.mjs —— 从暂停菜单传送回指定关卡
 *
 * 流程：Esc → 下移两次（避开「退出」）→ Enter 进系统接入界面 → 等加载 →
 *       Tab 把焦点移到右栏 → 选第 N 项 → Enter 传送。
 *
 * 用法：node probe/teleport.mjs [条目序号 1-based，默认 1 = 迷路森林]
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const target = Number(process.argv[2]) || 1
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const shot = async (n, w = 1000) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: w })
  if (c.ok) writeFileSync(`shots/${n}.png`, encodePng(c.width, c.height, c.data))
}
const tap = async (k, ms = 70, wait = 500) => { await nb.tap(k, ms); await new Promise((r) => setTimeout(r, wait)) }

console.log('1) Esc 打开暂停菜单')
await tap('Escape', 70, 1200)
await shot('tp-a-menu')

console.log('2) 下移两次到「回到泛用型系统接入界面」')
await tap('s', 60, 450)
await tap('s', 60, 450)
await shot('tp-b-selected')

console.log('3) Enter 进入系统接入界面')
await tap('Enter', 70, 2500)
console.log('4) 等加载（12 秒）')
await new Promise((r) => setTimeout(r, 12000))
await shot('tp-c-system')

console.log('5) Tab 把焦点移到右栏')
await tap('Tab', 60, 600)
// 回到列表顶部
for (let i = 0; i < 12; i++) { await nb.tap('w', 40); await new Promise((r) => setTimeout(r, 90)) }
await new Promise((r) => setTimeout(r, 500))

console.log(`6) 下移到第 ${target} 项`)
for (let i = 1; i < target; i++) { await tap('s', 55, 350) }
await shot('tp-d-level')

console.log('7) Enter 传送')
await tap('Enter', 70, 8000)
await shot('tp-e-arrived')
console.log('截图: shots/tp-a..tp-e')
await nb.dispose()

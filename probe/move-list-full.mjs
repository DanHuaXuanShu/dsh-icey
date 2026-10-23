/**
 * probe/move-list-full.mjs —— 把招式升级列表整屏翻完（3 屏），不按 Enter
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const shot = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 1100 })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  console.log(`  ${name}: ${c.width}x${c.height}`)
}

// 回到列表顶部（按 w 多次）
for (let i = 0; i < 20; i++) { await nb.tap('w', 40); await new Promise((r) => setTimeout(r, 60)) }
await new Promise((r) => setTimeout(r, 500))
console.log('已回到顶部')
await shot('mlv-1')

// 每次下移 9 项再拍（一屏 9 行）
for (let page = 2; page <= 3; page++) {
  for (let i = 0; i < 9; i++) { await nb.tap('s', 40); await new Promise((r) => setTimeout(r, 70)) }
  await new Promise((r) => setTimeout(r, 500))
  await shot(`mlv-${page}`)
}
console.log('（没按 Enter）')
await nb.dispose()

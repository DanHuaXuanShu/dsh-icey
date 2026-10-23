/**
 * probe/capture-moves2.mjs —— 强化界面已打开时，逐项截取每一招的说明
 * 只按 W/S，绝不按 Enter（那里 Enter = 花钱升级）
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const count = Number(process.argv[2]) || 18
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const crop = async (name, box, maxWidth = 0) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
  if (!c.ok) return null
  const x = Math.floor(c.width * box[0]), y = Math.floor(c.height * box[1])
  const w = Math.floor(c.width * (box[2] - box[0])), h = Math.floor(c.height * (box[3] - box[1]))
  const r = cropRgba(c.data, c.width, c.height, x, y, w, h)
  writeFileSync(`shots/${name}.png`, encodePng(r.width, r.height, r.data))
  return { w: r.width, h: r.height }
}

const LIST = [0.17, 0.22, 0.42, 0.80]
const DETAIL = [0.45, 0.60, 0.80, 0.82]

console.log('回到列表顶部…')
for (let i = 0; i < 30; i++) { await nb.tap('w', 40); await new Promise((r) => setTimeout(r, 50)) }
await new Promise((r) => setTimeout(r, 400))
await crop('m2-list-top', LIST)

for (let i = 1; i <= count; i++) {
  const idx = String(i).padStart(2, '0')
  const d = await crop(`m2-${idx}`, DETAIL)
  process.stdout.write(`  ${idx}: ${d ? d.w + 'x' + d.h : 'x'}\n`)
  await nb.tap('s', 45)
  await new Promise((r) => setTimeout(r, 400))
}
await crop('m2-list-bottom', LIST)
console.log('完成（没按 Enter）')
await nb.dispose()

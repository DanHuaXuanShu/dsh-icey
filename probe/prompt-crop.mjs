/**
 * probe/prompt-crop.mjs —— 原分辨率下把「提示框」那块裁出来存 PNG，人工确认外观
 *
 * 用法：node probe/prompt-crop.mjs [往右走多少毫秒（默认 2400）]
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng, cropRgba } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const walkMs = Number(process.argv[2]) || 2400
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

if (walkMs > 0) {
  console.log(`往右走 ${walkMs}ms…`)
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, walkMs))
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 500))
}

const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
if (!c.ok) { console.log('抓帧失败'); await nb.dispose(); process.exit(1) }
const { width: W, height: H, data } = c
console.log(`原分辨率 ${W}x${H}`)
writeFileSync('shots/pc-full.png', encodePng(W, H, data))

// 裁三个候选区域（比例 → 像素）
const boxes = [
  ['pc-right-mid', 0.55, 0.45, 0.95, 0.80],
  ['pc-tight', 0.60, 0.52, 0.86, 0.70],
  ['pc-lower', 0.55, 0.60, 0.95, 0.85],
]
for (const [name, x0r, y0r, x1r, y1r] of boxes) {
  const x = Math.floor(W * x0r), y = Math.floor(H * y0r)
  const w = Math.floor(W * (x1r - x0r)), h = Math.floor(H * (y1r - y0r))
  const cropped = cropRgba(data, W, H, x, y, w, h)
  writeFileSync(`shots/${name}.png`, encodePng(cropped.width, cropped.height, cropped.data))
  console.log(`  ${name}: ${w}x${h}  ← (${x},${y})`)
}
await nb.dispose()
console.log('看 shots/pc-full.png 和 shots/pc-tight.png')

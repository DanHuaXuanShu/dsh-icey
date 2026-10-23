/**
 * probe/chest-snap.mjs —— 一发现「宝箱候选」就裁图存下来，供人工确认
 *
 * 用法：node probe/chest-snap.mjs [最多存几张，默认 6] [最多观察秒数，默认 60]
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { analyzeEnvironment } from '../lib/autoplay.mjs'

const maxShots = Number(process.argv[2]) || 6
const maxSeconds = Number(process.argv[3]) || 60

mkdirSync('shots/chest', { recursive: true })
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const t0 = Date.now()
let shots = 0
let i = 0
console.log(`观察 ${maxSeconds} 秒，出现宝箱候选就裁图（最多 ${maxShots} 张）`)

while (Date.now() - t0 < maxSeconds * 1000 && shots < maxShots) {
  await new Promise((r) => setTimeout(r, 700))
  i++
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) continue
  const env = analyzeEnvironment(c.data, c.width, c.height)
  if (env.chest < 2 || env.chestX === null) continue

  // 以候选位置为中心裁一块（原分辨率）
  const cx = env.chestX * c.width
  const halfW = c.width * 0.16
  const x0 = Math.max(0, Math.floor(cx - halfW))
  const x1 = Math.min(c.width, Math.floor(cx + halfW))
  const y0 = Math.floor(c.height * 0.35)
  const y1 = c.height
  const cut = cropRgba(c.data, c.width, c.height, x0, y0, x1 - x0, y1 - y0)
  shots++
  const name = `chest-${String(shots).padStart(2, '0')}`
  writeFileSync(`shots/chest/${name}.png`, encodePng(cut.width, cut.height, cut.data))
  console.log(`  ${name}: 候选 ${env.chest} 格，x=${(env.chestX * 100).toFixed(0)}%  → 已裁图`)
}

console.log(`\n共 ${shots} 张 → shots/chest/`)
await nb.dispose()

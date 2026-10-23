/**
 * probe/find-station.mjs —— 长距离扫路，找「小机器人强化台」
 *
 * 判据收紧到 0.10%~0.60%（实测真提示框 0.23~0.40%；Boss 特效 0.9%~8% 会被排除），
 * 并把检测框限制在**地面上方**那条带（提示框在角色右中，不在脚下）。
 *
 * 用法：node probe/find-station.mjs left|right 秒数
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const dirKey = process.argv[2] === 'right' ? 'd' : 'a'
const seconds = Number(process.argv[3]) || 8

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const BOX = [0.40, 0.42, 0.92, 0.76]   // 地面上方、角色右侧
const LO = 0.0010, HI = 0.0060

async function scoreAndShot(tag) {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) return { s: 0 }
  const x = Math.floor(c.width * BOX[0]), y = Math.floor(c.height * BOX[1])
  const w = Math.floor(c.width * (BOX[2] - BOX[0])), h = Math.floor(c.height * (BOX[3] - BOX[1]))
  const cut = cropRgba(c.data, c.width, c.height, x, y, w, h)
  let bright = 0, n = 0
  for (let i = 0; i < cut.data.length; i += 4) {
    const lum = cut.data[i] * 0.299 + cut.data[i + 1] * 0.587 + cut.data[i + 2] * 0.114
    if (lum > 200) bright++
    n++
  }
  const s = bright / n
  if (tag) writeFileSync(`shots/${tag}.png`, encodePng(cut.width, cut.height, cut.data))
  return { s, box: cut }
}

console.log(`向 ${dirKey === 'd' ? '右' : '左'} 扫 ${seconds} 秒（每 600ms 一步）…`)
let hit = null
for (let t = 0; t < seconds * 1000; t += 600) {
  await new Promise((r) => setTimeout(r, 450))       // 站定才渲染提示框
  const { s } = await scoreAndShot(null)
  const pct = (s * 100).toFixed(3)
  if (s >= LO && s <= HI) {
    console.log(`  ${(t / 1000).toFixed(1)}s 命中 ${pct}% → 停`)
    hit = t
    break
  }
  if (s > HI) console.log(`  ${(t / 1000).toFixed(1)}s ${pct}% （太亮，特效，继续）`)
  await nb.keydown(dirKey)
  await new Promise((r) => setTimeout(r, 400))
  await nb.keyup(dirKey)
}

const full = async (name, w = 1100) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: w })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
}

if (hit === null) {
  console.log('这条路上没找到。最后整屏: shots/fs-last.png')
  await full('fs-last')
  await nb.dispose()
  process.exit(2)
}

await full('fs-prompt')
console.log('按 Enter …')
await nb.tap('Enter', 70)
await new Promise((r) => setTimeout(r, 2000))
await full('fs-opened')
console.log('截图: shots/fs-prompt.png / fs-opened.png')
await nb.dispose()

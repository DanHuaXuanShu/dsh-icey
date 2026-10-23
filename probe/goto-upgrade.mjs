/**
 * probe/goto-upgrade.mjs —— 自动走到强化台并打开招式界面
 *
 * 复用之前验证过的「提示框检测」：往一个方向小步移动，每步算提示区白字占比，
 * 超过阈值说明贴到可互动物了 → 立刻按 Enter（别等，提示框会消失）。
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const dirKey = process.argv[2] === 'left' ? 'a' : 'd'
const maxSteps = Number(process.argv[3]) || 14

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 300))

const BOX = [0.30, 0.35, 0.99, 0.90]

/** 抓帧 → 算提示区白字占比 */
async function score() {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) return 0
  const x = Math.floor(c.width * BOX[0]), y = Math.floor(c.height * BOX[1])
  const w = Math.floor(c.width * (BOX[2] - BOX[0])), h = Math.floor(c.height * (BOX[3] - BOX[1]))
  const cut = cropRgba(c.data, c.width, c.height, x, y, w, h)
  let bright = 0, n = 0
  for (let i = 0; i < cut.data.length; i += 4) {
    const lum = cut.data[i] * 0.299 + cut.data[i + 1] * 0.587 + cut.data[i + 2] * 0.114
    if (lum > 200) bright++
    n++
  }
  return bright / n
}

const fullShot = async (name, maxWidth = 1100) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
}

console.log(`向 ${dirKey === 'd' ? '右' : '左'} 逐段找强化台（每步 350ms）…`)
let found = false
for (let i = 1; i <= maxSteps; i++) {
  // 停一下再测（提示框要站定才渲染）
  await new Promise((r) => setTimeout(r, 450))
  const s = await score()
  console.log(`  第 ${i} 段 提示区白字 ${(s * 100).toFixed(3)}%`)
  // 上下界都要：真提示框 0.23~0.40%；特效/爆炸会飙到 8% 以上（误闯 Boss 区时踩过）
  if (s >= 0.0008 && s <= 0.02) { found = true; console.log('  → 检测到提示框，停在这'); break }
  if (s > 0.02) console.log('  （太亮，像是特效不是提示框，继续走）')
  await nb.keydown(dirKey)
  await new Promise((r) => setTimeout(r, 350))
  await nb.keyup(dirKey)
}

if (!found) {
  console.log('没找到可互动物。最后一张整屏：shots/goto-last.png')
  await fullShot('goto-last')
  await nb.dispose()
  process.exit(2)
}

await fullShot('goto-prompt')
console.log('按 Enter 打开界面…')
await nb.tap('Enter', 70)
await new Promise((r) => setTimeout(r, 2000))
await fullShot('goto-opened')
console.log('截图: shots/goto-prompt.png / goto-opened.png')
await nb.dispose()

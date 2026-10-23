/**
 * probe/prompt-live-crop.mjs —— 验证「动作之后立刻裁提示区」能读到提示文字
 *
 * 已知现象：提示框（「坐标：… / 海拔：… / ⏎: 开启强化」）
 *   ① 只在游戏窗口**前台**时渲染
 *   ② 动作之后会短暂出现
 * 所以要在同一个进程里：抢前台 → 轻挪一下 → 立刻裁图。
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const BOX = { x0: 0.42, y0: 0.38, x1: 0.99, y1: 0.86 }

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 300))

/** 裁提示区并统计其中的亮字像素（>200），用来判断有没有提示文字 */
async function cropAndScore(tag) {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) { console.log('  抓帧失败'); return 0 }
  const x = Math.floor(c.width * BOX.x0), y = Math.floor(c.height * BOX.y0)
  const w = Math.floor(c.width * (BOX.x1 - BOX.x0)), h = Math.floor(c.height * (BOX.y1 - BOX.y0))
  const cut = cropRgba(c.data, c.width, c.height, x, y, w, h)
  writeFileSync(`shots/plc-${tag}.png`, encodePng(cut.width, cut.height, cut.data))
  // 统计亮像素（白字）
  let bright = 0, n = 0
  for (let i = 0; i < cut.data.length; i += 4) {
    const lum = cut.data[i] * 0.299 + cut.data[i + 1] * 0.587 + cut.data[i + 2] * 0.114
    if (lum > 200) bright++
    n++
  }
  const pct = (bright / n) * 100
  console.log(`  ${tag}: ${cut.width}x${cut.height}  亮像素 ${pct.toFixed(3)}%`)
  return pct
}

console.log('A) 静止状态裁一张')
await cropAndScore('idle')

console.log('B) 轻挪一下（往右 300ms），立刻裁')
await nb.keydown('d')
await new Promise((r) => setTimeout(r, 300))
await nb.keyup('d')
await new Promise((r) => setTimeout(r, 250))
await cropAndScore('after-move')

console.log('C) 再等等（1.5 秒后）裁一张，看提示是不是会消失')
await new Promise((r) => setTimeout(r, 1500))
await cropAndScore('after-wait')

console.log('\n对比 shots/plc-idle.png / plc-after-move.png / plc-after-wait.png')
await nb.dispose()

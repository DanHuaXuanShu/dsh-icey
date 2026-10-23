/**
 * probe/prompt-sweep.mjs —— 一边靠近一边采样，找「提示框出现」的时刻
 *
 * 逐段向右/向左移动 400ms，每段采 2 帧，打印 promptBright 与 hudBright，
 * 并保存每次峰值帧，用来确认提示框长什么样、信号有多强。
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const dir = process.argv[2] === 'left' ? 'a' : 'd'
const steps = Number(process.argv[3]) || 8

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))

const at = async () => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
  const m = analyzeFrame(c.data, c.width, c.height, null)
  return { p: m.promptBright * 100, h: m.hudBright * 100 }
}

let best = { p: -1 }
console.log(`向 ${dir === 'd' ? '右' : '左'} 逐段移动，每段 400ms：`)
for (let i = 0; i <= steps; i++) {
  const a = await at()
  await new Promise((r) => setTimeout(r, 200))
  const b = await at()
  const p = Math.max(a.p, b.p)
  const h = Math.max(a.h, b.h)
  console.log(`  第 ${i} 段   promptBright=${p.toFixed(3)}%   hudBright=${h.toFixed(2)}%`)
  if (p > best.p) {
    best = { p, h, i }
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    writeFileSync(`shots/prompt-best-${i}.png`, encodePng(c.width, c.height, c.data))
  }
  if (i < steps) {
    await nb.keydown(dir)
    await new Promise((r) => setTimeout(r, 400))
    await nb.keyup(dir)
    await new Promise((r) => setTimeout(r, 250))
  }
}
console.log(`\n峰值：第 ${best.i} 段 promptBright=${best.p.toFixed(3)}%（截图 shots/prompt-best-${best.i}.png）`)
await nb.dispose()

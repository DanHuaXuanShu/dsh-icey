/**
 * probe/attack-test.mjs —— 按 j 后立刻抓帧，看有没有挥剑特效
 * 攻击是短促动画，必须在 100–250ms 内抓到，否则已经恢复待机。
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))

const grab = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  if (!c.ok) return null
  if (name) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  const m = analyzeFrame(c.data, c.width, c.height, null)
  return { rgba: c.data, width: c.width, height: c.height, hud: m.hud }
}

const base = await grab('atk-0-before')
console.log('基线:', JSON.stringify({ hud: +base.hud.toFixed(1) }))

console.log('按 j（普通攻击），然后在 120ms / 260ms 各抓一帧')
await nb.tap('j', 60)
await new Promise((r) => setTimeout(r, 120))
const f1 = await grab('atk-1-120ms')
await new Promise((r) => setTimeout(r, 140))
const f2 = await grab('atk-2-260ms')

for (const [label, fr] of [['120ms', f1], ['260ms', f2]]) {
  const m = analyzeFrame(fr.rgba, fr.width, fr.height, base)
  console.log(`  ${label}: motion=${(m.motion * 100).toFixed(2)}%  hud=${m.hud.toFixed(1)}`)
}

console.log('\n再按重击 i，200ms 后抓帧')
await new Promise((r) => setTimeout(r, 700))
await nb.tap('i', 60)
await new Promise((r) => setTimeout(r, 200))
const f3 = await grab('atk-3-heavy')
const m3 = analyzeFrame(f3.rgba, f3.width, f3.height, base)
console.log(`  重击 200ms: motion=${(m3.motion * 100).toFixed(2)}%`)

console.log('\n截图: shots/atk-*.png')
await nb.dispose()

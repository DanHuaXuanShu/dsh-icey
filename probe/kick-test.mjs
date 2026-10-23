/**
 * probe/kick-test.mjs —— 试「补发激活消息」能不能让键盘对 ICEY 生效
 * 对照：不 kick 按 d、kick 后按 d、kick 后按 j，看画面差异。
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const grab = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
  if (!c.ok) return null
  if (name) {
    const big = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    writeFileSync(`shots/${name}.png`, encodePng(big.width, big.height, big.data))
  }
  return { rgba: c.data, width: c.width, height: c.height }
}

const holdD = async (label) => {
  const before = await grab(null)
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, 1500))
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 250))
  const after = await grab(`kick-${label}`)
  const mb = analyzeFrame(before.rgba, before.width, before.height, null)
  const ma = analyzeFrame(after.rgba, after.width, after.height, { ...before, hud: mb.hud })
  console.log(`  ${label.padEnd(16)} motion=${(ma.motion * 100).toFixed(2)}%  hud=${ma.hud.toFixed(1)}`)
  return ma.motion
}

await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))
console.log('A) 只 focus，按 d：')
const a = await holdD('A-focus-only')

const k = await nb.kick(f.hwnd)
console.log('B) kick 结果:', JSON.stringify(k))
await new Promise((r) => setTimeout(r, 500))
const b = await holdD('B-kicked')

const c = await nb.click(f.hwnd, 20, 20)
console.log('C) click:', JSON.stringify(c.ok))
await new Promise((r) => setTimeout(r, 400))
const cc = await holdD('C-clicked')

await nb.dispose()
console.log(`\nmotion 对照：focus=${(a * 100).toFixed(2)}%  kick=${(b * 100).toFixed(2)}%  click=${(cc * 100).toFixed(2)}%`)
console.log('（走路会让整个背景平移，motion 通常 >10%；待机动画 ~1.5%）')

/**
 * probe/motion-walk.mjs —— 录一组「走路」的连续帧 motion，用来定战斗阈值
 *
 * 已有数据（连续 100ms 帧）：
 *   战斗中 motion 中位 24.6%
 *   空地静止 motion 中位 0.7%
 * 缺的是「走路」——如果走路的 motion 也很高，那 motion 就不能单独当战斗判据。
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng, diffRatio } from '../lib/png.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 3
const dir = 'shots/walk-motion'
mkdirSync(dir, { recursive: true })

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async () => {
  for (let k = 0; k < 3; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 200))

// 按住 D 往前走，同时连拍
const dirKey = process.argv[3] || 'd'
await nb.keydown(dirKey)
const t0 = Date.now()
let prev = null
let i = 0
const rows = []
while (Date.now() - t0 < seconds * 1000) {
  const c = await grab()
  if (!c) continue
  i++
  const a = analyzeFrame(c.data, c.width, c.height, prev)
  writeFileSync(`${dir}/f${String(i).padStart(2, '0')}.png`, encodePng(c.width, c.height, c.data))
  rows.push({ motion: a.motion || 0, hudKick: a.hudKick || 0, hudBright: a.hudBright || 0, at: Date.now() - t0 })
  prev = { rgba: c.data, width: c.width, height: c.height, hud: a.hud }
}
await nb.keyup(dirKey)
await nb.releaseAll().catch(() => null)

const med = (k) => {
  const s = rows.map((r) => r[k]).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const p90 = (k) => {
  const s = rows.map((r) => r[k]).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0
}

console.log(`走路 ${seconds} 秒，连拍 ${rows.length} 帧`)
console.log(`  motion    中位 ${(med('motion') * 100).toFixed(2)}%   90分位 ${(p90('motion') * 100).toFixed(2)}%`)
console.log(`  hudKick   中位 ${(med('hudKick') * 100).toFixed(2)}%`)
console.log(`  hudBright 中位 ${(med('hudBright') * 100).toFixed(2)}%`)
console.log('\n逐帧 motion：')
for (const r of rows) {
  console.log(`  ${String(r.at).padStart(5)}ms  ${(r.motion * 100).toFixed(1).padStart(6)}%  ${'█'.repeat(Math.min(30, Math.round(r.motion * 60)))}`)
}

await nb.dispose()

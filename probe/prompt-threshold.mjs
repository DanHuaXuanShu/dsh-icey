/**
 * probe/prompt-threshold.mjs —— 用正确阈值量「互动提示框」信号
 *
 * 结论线索：提示框白字实测亮度只有 ~180（不是 235），所以之前的阈值把信号全过滤掉了。
 * 这里对比「贴着机关（有提示框）」和「走开（没提示框）」两处的占比。
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const TH = Number(process.argv[2]) || 180
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const ratio = async () => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
  const { width: W, height: H } = c
  const rgba = c.data
  const x0 = Math.floor(W * 0.55), x1 = Math.floor(W * 0.90)
  const y0 = Math.floor(H * 0.50), y1 = Math.floor(H * 0.75)
  let n = 0, cnt = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * 4
      const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      if (lum > TH) n++
      cnt++
    }
  }
  return (n / cnt) * 100
}

const shot = async (n) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  writeFileSync(`shots/${n}.png`, encodePng(c.width, c.height, c.data))
}
const walk = async (k, ms) => { await nb.keydown(k); await new Promise(r => setTimeout(r, ms)); await nb.keyup(k); await new Promise(r => setTimeout(r, 400)) }
const avg = async (n = 3) => { const v = []; for (let i = 0; i < n; i++) { v.push(await ratio()); await new Promise(r => setTimeout(r, 200)) } return v.reduce((a, b) => a + b, 0) / v.length }

console.log(`阈值 ${TH}`)
console.log('A) 当前位置（机器人旁，应该有提示框）')
const a = await avg(); await shot('thr-near')
console.log(`   ${a.toFixed(4)}%`)

console.log('B) 往左走 2 秒（走开）')
await walk('a', 2000)
const b = await avg(); await shot('thr-far')
console.log(`   ${b.toFixed(4)}%`)

console.log('C) 往右走回 2 秒')
await walk('d', 2000)
const c = await avg(); await shot('thr-near2')
console.log(`   ${c.toFixed(4)}%`)

console.log(`\n对照：贴近 ${a.toFixed(4)}% / ${c.toFixed(4)}%   走开 ${b.toFixed(4)}%`)
const near = (a + c) / 2
console.log(near > b * 2 && near > 0.01 ? '✅ 信号可用' : '⚠️ 信号仍然不够区分（看截图人工确认）')
await nb.dispose()

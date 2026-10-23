/**
 * probe/move-test2.mjs —— 到底能不能动：按 d 走 1.5 秒，看画面是否整体位移
 *
 * 判定方式：走路会让**整个背景横向平移**，所以全画面差异会明显大于待机动画（~1.5%）。
 * 分别测「直接按」和「先点一下再按」，用来确认是否需要鼠标激活。
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
await nb.focus(f.hwnd)

const grab = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 400 })
  if (!c.ok) return null
  if (name) {
    const big = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    writeFileSync(`shots/${name}.png`, encodePng(big.width, big.height, big.data))
  }
  return { rgba: c.data, width: c.width, height: c.height }
}

const trial = async (label, { clickFirst }) => {
  if (clickFirst) {
    const c = await nb.click(f.hwnd, 20, 20)
    console.log(`  [${label}] click=${JSON.stringify(c.ok)}`)
    await new Promise((r) => setTimeout(r, 400))
  }
  const before = await grab(null)
  await nb.keydown('d')
  await new Promise((r) => setTimeout(r, 1500))
  await nb.keyup('d')
  await new Promise((r) => setTimeout(r, 250))
  const after = await grab(null)
  const mb = analyzeFrame(before.rgba, before.width, before.height, null)
  const ma = analyzeFrame(after.rgba, after.width, after.height, { ...before, hud: mb.hud })
  const moved = ma.motion > 0.10   // 位移会让 >10% 的像素变化，远高于待机 1.5%
  console.log(`  [${label}] motion=${(ma.motion * 100).toFixed(2)}%  → ${moved ? '动了 ✅' : '没动 ❌'}`)
  return moved
}

console.log('A) 不点击，直接按 d')
const a = await trial('no-click', { clickFirst: false })
console.log('B) 先点一下，再按 d')
const b = await trial('click', { clickFirst: true })
console.log('C) 再直接按 d（确认点击后是否持续有效）')
const c = await trial('after-click', { clickFirst: false })

writeFileSync('shots/move-test2-done.txt', `A=${a} B=${b} C=${c}\n`, 'utf8')
await nb.dispose()
console.log(`\n结论：不点击 ${a ? '能动' : '不能动'}；点击后 ${b ? '能动' : '不能动'}；点击后不重复点击 ${c ? '仍能动' : '又不能动'}`)

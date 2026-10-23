/**
 * probe/activate-test.mjs —— 验证「一次真实鼠标点击」是不是键盘生效的前提
 *
 * 背景：AttachThreadInput 抢前台只能让窗口到最前，Unity 有时不认这种"伪激活"，
 * 键盘发了没反应（画面还在动，说明游戏没死）。实测点一下鼠标之后键盘才工作。
 *
 * 步骤：focus → 记录基线 → 按 Esc（应无反应）→ 点一下左上角 → 再按 Esc（应弹菜单）
 */
import { NativeBackend } from '../lib/host.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const snap = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
  if (!c.ok) return null
  writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  const m = analyzeFrame(c.data, c.width, c.height, null)
  return { hash: m.hud.toFixed(1), bright: (m.hudBright * 100).toFixed(2) }
}

await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 400))
console.log('1) 基线:', JSON.stringify(await snap('act-0-base')))

console.log('2) 不点击，直接按 Esc')
await nb.tap('Escape', 80)
await new Promise((r) => setTimeout(r, 1200))
console.log('   →', JSON.stringify(await snap('act-1-esc-noclick')))

console.log('3) 点一下窗口左上角（20,20），再按 Esc')
const click = await nb.click(f.hwnd, 20, 20)
console.log('   click:', JSON.stringify(click))
await new Promise((r) => setTimeout(r, 500))
await nb.tap('Escape', 80)
await new Promise((r) => setTimeout(r, 1200))
console.log('   →', JSON.stringify(await snap('act-2-esc-afterclick')))

console.log('4) 再按一次 Esc 关掉菜单，确认能继续操作')
await nb.tap('Escape', 80)
await new Promise((r) => setTimeout(r, 1000))
console.log('   →', JSON.stringify(await snap('act-3-resumed')))

await nb.dispose()
console.log('\n看 shots/act-*.png 判断：第 2 步应无菜单，第 3 步应出现暂停菜单')

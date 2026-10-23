/**
 * probe/capture-moves.mjs —— 逐项截取招式强化界面里每一招的说明
 *
 * 每项只裁「说明 + 输入 + 价格」那块（原分辨率），列表名单独拍一张。
 * 全程只按 W/S 移动，**绝不按 Enter**（那里 Enter 是花钱升级）。
 *
 * 用法：node probe/capture-moves.mjs [项数，默认 20]
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const count = Number(process.argv[2]) || 20
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

/** 裁一块比例区域 */
const cropShot = async (name, box) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) return null
  const x = Math.floor(c.width * box[0]), y = Math.floor(c.height * box[1])
  const w = Math.floor(c.width * (box[2] - box[0])), h = Math.floor(c.height * (box[3] - box[1]))
  const r = cropRgba(c.data, c.width, c.height, x, y, w, h)
  writeFileSync(`shots/${name}.png`, encodePng(r.width, r.height, r.data))
  return { w: r.width, h: r.height }
}

// 列表（左栏）与详情（右栏说明）各拍一张
const LIST = [0.18, 0.18, 0.42, 0.88]
const DETAIL = [0.42, 0.52, 0.86, 0.88]

console.log('1) 按 Enter 打开强化界面')
await nb.tap('Enter', 70)
await new Promise((r) => setTimeout(r, 1500))

console.log('2) 回到列表顶部')
for (let i = 0; i < 30; i++) { await nb.tap('w', 40); await new Promise((r) => setTimeout(r, 55)) }
await new Promise((r) => setTimeout(r, 500))
await cropShot('mv-list-top', LIST)

console.log(`3) 逐项截取（共 ${count} 项）`)
for (let i = 1; i <= count; i++) {
  const idx = String(i).padStart(2, '0')
  const d = await cropShot(`mv-${idx}`, DETAIL)
  console.log(`  第 ${i} 项截图 ${d ? d.w + 'x' + d.h : '失败'}`)
  await nb.tap('s', 45)
  await new Promise((r) => setTimeout(r, 420))
}
await cropShot('mv-list-bottom', LIST)
console.log('\n完成。列表名: shots/mv-list-top.png；每一项: shots/mv-01..mv-' + String(count).padStart(2, '0') + '.png')
console.log('（全程没按 Enter，升级点未动）')
await nb.dispose()

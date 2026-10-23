/**
 * probe/move-list.mjs —— 把游戏里的「招式升级界面」逐项翻一遍并截图
 *
 * 界面底部写着：⏎ 升级 / Esc 关闭。列表用 W/S 上下选。
 * 这里只移动选中项并截图，**绝不按 Enter**（那会花掉升级点）。
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng, cropRgba } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const steps = Number(process.argv[2]) || 12
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const shot = async (name, crop) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (!c.ok) return
  if (crop) {
    const x = Math.floor(c.width * crop[0]), y = Math.floor(c.height * crop[1])
    const w = Math.floor(c.width * (crop[2] - crop[0])), h = Math.floor(c.height * (crop[3] - crop[1]))
    const r = cropRgba(c.data, c.width, c.height, x, y, w, h)
    writeFileSync(`shots/${name}.png`, encodePng(r.width, r.height, r.data))
  } else {
    writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  }
}

// 先整屏一张，看列表有没有滚动条 / 共几项
await shot('ml-full-0')
console.log('已存 shots/ml-full-0.png')

// 逐项下移，只裁「列表 + 右侧描述」那块
for (let i = 1; i <= steps; i++) {
  await nb.tap('s', 60)
  await new Promise((r) => setTimeout(r, 500))
  await shot(`ml-${String(i).padStart(2, '0')}`, [0.18, 0.24, 0.82, 0.85])
  console.log(`  第 ${i} 项截图完成`)
}
await shot('ml-full-last')
console.log('\n最后整屏：shots/ml-full-last.png')
console.log('（没按 Enter，升级点没动）')
await nb.dispose()

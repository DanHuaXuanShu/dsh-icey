/**
 * probe/capture-moves3.mjs —— 成对截图：每张同时包含「列表（含高亮）+ 右侧说明」
 *
 * 前两次的教训：只截右侧说明、靠索引对齐，结果中途有 s 被吞掉，整段错位。
 * 现在每张图自带高亮行，名字和说明在同一张图里，不需要再猜对应关系。
 * 步进加长到 700ms，确保列表真的切过去了。
 */
import { NativeBackend } from '../lib/host.mjs'
import { cropRgba, encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const count = Number(process.argv[2]) || 17
const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

const BOX = [0.17, 0.20, 0.80, 0.90]

const pair = async (name, maxWidth = 900) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth })
  if (!c.ok) return null
  const x = Math.floor(c.width * BOX[0]), y = Math.floor(c.height * BOX[1])
  const w = Math.floor(c.width * (BOX[2] - BOX[0])), h = Math.floor(c.height * (BOX[3] - BOX[1]))
  const r = cropRgba(c.data, c.width, c.height, x, y, w, h)
  writeFileSync(`shots/${name}.png`, encodePng(r.width, r.height, r.data))
  return { w: r.width, h: r.height }
}

console.log('回到列表顶部（多按几次 + 长等待）')
for (let i = 0; i < 40; i++) { await nb.tap('w', 40); await new Promise((r) => setTimeout(r, 90)) }
await new Promise((r) => setTimeout(r, 800))

console.log(`逐项成对截图（${count} 项，每步 700ms）`)
for (let i = 1; i <= count; i++) {
  const idx = String(i).padStart(2, '0')
  const p = await pair(`p3-${idx}`)
  process.stdout.write(`  ${idx}: ${p ? p.w + 'x' + p.h : '失败'}\n`)
  await nb.tap('s', 50)
  await new Promise((r) => setTimeout(r, 700))
}
console.log('完成（未按 Enter）')
await nb.dispose()

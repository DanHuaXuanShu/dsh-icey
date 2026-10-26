/**
 * probe/_skill-audit.mjs —— 把「招式升级界面」20 项逐项翻拍，供人核对文本与演示。
 *
 * 目的：不凭记忆，也不信旧转录。每项拍「说明文字 + 输入方式 + 演示动画 3 帧」。
 *
 * 安全：只按 w/s(列表上下)、不按 Enter（Enter 是花钱升级）。
 *
 * 产物：shots/skills/pair-XX.png —— 每张两个招式，竖着叠。
 *
 * 用法：node probe/_skill-audit.mjs
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const TOTAL = 20
const DEMO_FRAMES = 3
const FRAME_GAP = 140
const PER_SHEET = 2

mkdirSync('shots/skills', { recursive: true })

const nb = new NativeBackend()
await nb.start()
const found = await nb.find('ICEY.exe')
if (!found.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(found.hwnd)
await new Promise((r) => setTimeout(r, 400))

const grab = async () => {
  const c = await nb.capture(found.hwnd, 'printwindow', { format: 'rgba', maxWidth: 1602 })
  if (!c.ok) throw new Error('抓帧失败: ' + (c.error || ''))
  return c
}

function crop(c, x0, y0, x1, y1) {
  const w = Math.max(1, Math.min(c.width - x0, x1 - x0))
  const h = Math.max(1, Math.min(c.height - y0, y1 - y0))
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * c.width + x0) * 4
    out.set(c.data.subarray(src, src + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

function hstack(imgs) {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((a, i) => a + i.width, 0)
  const out = new Uint8Array(w * h * 4)
  let dx = 0
  for (const img of imgs) {
    for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * w + dx) * 4)
    dx += img.width
  }
  return { data: out, width: w, height: h }
}

function vstack(imgs) {
  const w = Math.max(...imgs.map((i) => i.width))
  const h = imgs.reduce((a, i) => a + i.height, 0)
  const out = new Uint8Array(w * h * 4)
  let dy = 0
  for (const img of imgs) {
    for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((dy + y) * w) * 4)
    dy += img.height
  }
  return { data: out, width: w, height: h }
}

const BOX = {
  text: [0.300, 0.615, 0.800, 0.795],   // 说明文字 + 输入方式
  demo: [0.450, 0.270, 0.790, 0.595],   // 演示动画面板
}
const px = (c, box) => [
  Math.round(box[0] * c.width), Math.round(box[1] * c.height),
  Math.round(box[2] * c.width), Math.round(box[3] * c.height),
]

// 回到列表顶部（多按几次 w 到顶，按不动就是到顶了）
for (let i = 0; i < 25; i++) { await nb.tap('w', 30); await new Promise((r) => setTimeout(r, 45)) }
await new Promise((r) => setTimeout(r, 600))
console.log('已回到顶部')

const sheets = []
let pending = []

for (let i = 1; i <= TOTAL; i++) {
  if (i > 1) {
    await nb.tap('s', 30)
    await new Promise((r) => setTimeout(r, 450))
  }
  const demos = []
  let text = null
  for (let f = 0; f < DEMO_FRAMES; f++) {
    if (f > 0) await new Promise((r) => setTimeout(r, FRAME_GAP))
    const c = await grab()
    const d = px(c, BOX.demo)
    const t = px(c, BOX.text)
    demos.push(crop(c, d[0], d[1], d[2], d[3]))
    if (f === 0) text = crop(c, t[0], t[1], t[2], t[3])
  }
  pending.push(vstack([text, hstack(demos)]))
  console.log(`  第 ${i} 项已拍`)
  if (pending.length === PER_SHEET || i === TOTAL) {
    const sheet = vstack(pending)
    const name = `shots/skills/pair-${String(sheets.length + 1).padStart(2, '0')}.png`
    writeFileSync(name, encodePng(sheet.width, sheet.height, sheet.data))
    console.log(`  → ${name}（第 ${i - pending.length + 1}~${i} 项，${sheet.width}x${sheet.height}）`)
    sheets.push(name)
    pending = []
  }
}

console.log(`完成，共 ${sheets.length} 张。没有按 Enter。`)
await nb.dispose()

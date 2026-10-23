/**
 * probe/prompt-native.mjs —— 用**原分辨率**找「互动提示框」的可靠判据
 *
 * 上一轮失败的教训：把画面缩到 400 宽再测，细笔画的白字被缩放糊掉了，
 * 阈值 180 只剩 0.05%、200 以上全 0。这次不缩图。
 *
 * 同时量两个东西：
 *   ① 白字占比（亮度 > 200 / 220 / 240）在右中区域
 *   ② 面板背景：提示框背后那块半透明深色矩形（低亮度、低方差）
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng } from '../lib/png.mjs'
import { writeFileSync } from 'node:fs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
await nb.focus(f.hwnd)

/** 在给定区域里统计：白字占比（多阈值）+ 暗色面板占比 */
function metrics(rgba, W, H, box) {
  const x0 = Math.floor(W * box.x0), x1 = Math.floor(W * box.x1)
  const y0 = Math.floor(H * box.y0), y1 = Math.floor(H * box.y1)
  const out = { n: 0, b200: 0, b220: 0, b240: 0, dark: 0, sum: 0, sum2: 0 }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      out.n++
      out.sum += lum
      out.sum2 += lum * lum
      if (lum > 200) out.b200++
      if (lum > 220) out.b220++
      if (lum > 240) out.b240++
      if (lum < 60) out.dark++
    }
  }
  const mean = out.sum / out.n
  const varr = out.sum2 / out.n - mean * mean
  return {
    white200: (out.b200 / out.n) * 100,
    white220: (out.b220 / out.n) * 100,
    white240: (out.b240 / out.n) * 100,
    dark: (out.dark / out.n) * 100,
    mean,
    std: Math.sqrt(Math.max(0, varr)),
  }
}

const grab = async () => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 960 })
  return { rgba: c.data, W: c.width, H: c.height, c }
}

const save = async (name) => {
  const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 0 })
  if (c.ok) writeFileSync(`shots/${name}.png`, encodePng(c.width, c.height, c.data))
  return c
}

const BOX = { x0: 0.48, y0: 0.42, x1: 0.98, y1: 0.82 }

console.log('逐段移动并采样（原分辨率 960 宽）…')
for (let i = 0; i <= 6; i++) {
  const g = await grab()
  const m = metrics(g.rgba, g.W, g.H, BOX)
  console.log(
    `  第 ${i} 段  白200=${m.white200.toFixed(3)}%  白220=${m.white220.toFixed(3)}%  `
    + `白240=${m.white240.toFixed(3)}%  暗=${m.dark.toFixed(1)}%  mean=${m.mean.toFixed(1)}  std=${m.std.toFixed(1)}`,
  )
  if (m.white220 > 0.15) await save(`prompt-hit-${i}`)
  if (i < 6) {
    await nb.keydown('a')
    await new Promise((r) => setTimeout(r, 400))
    await nb.keyup('a')
    await new Promise((r) => setTimeout(r, 250))
  }
}
const c = await save('prompt-last-native')
console.log(`\n最后一张：${c.width}x${c.height}（原分辨率）→ shots/prompt-last-native.png`)
await nb.dispose()

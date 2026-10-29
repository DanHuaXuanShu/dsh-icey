// 验证「强化界面」判据跨分辨率是否稳定：把样本缩成多种宽度再量同一批指标。
//
//   node probe/upgrade-menu-sweep.mjs
//
// 为什么本地缩就行：插件分析时也是把帧缩到固定宽度再算，所以「同一张图换宽度」
// 等价于「同一个画面在不同窗口尺寸下」。比再抓几张同分辨率的更有用。
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const CASES = [
  ['probe/fixtures/upgrade-menu.png', 'upgrade'],
  ['probe/fixtures/station-fullframe.png', 'game'],
  ['probe/fixtures/station-negative.png', 'game'],
  ['shots/watch/w0008.png', 'pause'],
  ['shots/combat/c0001.png', 'combat'],
  ['shots/combat/c0005.png', 'combat'],
  // 2026-10-29 从录像抽的「别的界面」—— 这几张是判据的关键负样本：
  // 如果把招式说明 / 地图列表 / 死亡画面误判成强化界面，插件走进去按 Enter 就会乱花钱。
  ['shots/ui-neg/t285.png', '设置菜单'],
  ['shots/ui-neg/t500.png', '招式说明'],
  ['shots/ui-neg/t790.png', '死亡画面'],
  ['shots/ui-neg/t1032.png', '地图列表'],
]
const WIDTHS = [1280, 720]

const isGold = (r, g, b) => r > 150 && g > 120 && b < 110 && r - b > 60 && g - b > 40

function measure(rgba, width, height) {
  let dark = 0, tot = 0
  const X0 = 0.08, X1 = 0.45
  const xa = Math.floor(X0 * width), xb = Math.floor(X1 * width)
  const rowGold = new Uint16Array(height), rowPx = new Uint16Array(height)
  const box = { x0: 0.46, y0: 0.27, x1: 0.78, y1: 0.55 }
  let boxLum = 0, boxN = 0
  for (let y = 0; y < height; y++) {
    const base = y * width * 4
    const inBoxY = y >= box.y0 * height && y < box.y1 * height
    for (let x = 0; x < width; x++) {
      const i = base + x * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (x >= xa && x < xb) {
        rowPx[y]++
        if (isGold(r, g, b)) rowGold[y]++
      }
      if (inBoxY && x >= box.x0 * width && x < box.x1 * width) { boxLum += lum; boxN++ }
      if (lum < 60) dark++
      tot++
    }
  }
  let goldRows = 0
  for (let y = 0; y < height; y++) if (rowPx[y] && rowGold[y] / rowPx[y] >= 0.02) goldRows++
  return { darkRatio: dark / tot, goldRows, boxMeanLum: boxN ? boxLum / boxN : 0 }
}

function rescale(img, W) {
  const H = Math.max(1, Math.round((img.height * W) / img.width))
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / H))
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / W))
      const si = (sy * img.width + sx) * 4, di = (y * W + x) * 4
      out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]
      out[di + 2] = img.rgba[si + 2]; out[di + 3] = 255
    }
  }
  return { rgba: out, width: W, height: H }
}

console.log('类别'.padEnd(9) + '宽'.padStart(6) + '暗占比'.padStart(9) + '左列金行'.padStart(9) + '右中亮度'.padStart(9) + '   判定(dark>78% 且 box>90)')
for (const [file, kind] of CASES) {
  if (!fs.existsSync(file)) { console.log(`跳过 ${file}`); continue }
  const img = decodePng(fs.readFileSync(file))
  for (const W of WIDTHS) {
    const s = rescale(img, W)
    const m = measure(s.rgba, s.width, s.height)
    const verdict = (m.darkRatio > 0.78 && m.boxMeanLum > 90) ? '★强化界面' : ''
    console.log(
      kind.padEnd(9) + String(W).padStart(6) +
      (m.darkRatio * 100).toFixed(1).padStart(8) + '%' +
      String(m.goldRows).padStart(9) +
      m.boxMeanLum.toFixed(1).padStart(9) +
      '   ' + verdict,
    )
  }
}

// 联系表：把一串帧拼成一张图，用来一眼看「同一段时间里画面在怎么动」。
//
//   node probe/sheet.mjs shots/timeline f00110 f00120 f00130 f00140
//   node probe/sheet.mjs shots/timeline "f00105..f00160:6"        # 起..止:步长
//
// 每格缩到 320 宽，2 列排布，左上角标帧号。输出 shots/sheet/<名字>.png
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'

const [dir, ...specs] = process.argv.slice(2)
if (!dir || !specs.length) {
  console.log('用法：node probe/sheet.mjs <目录> f00010 f00020 ... 或 "<前缀><起>..<前缀><止>:<步长>"')
  process.exit(1)
}

const names = []
for (const s of specs) {
  const m = /^(.*?)(\d+)\.\.(?:.*?)(\d+):(\d+)$/.exec(s)
  if (m) {
    const [, pre, a, b, step] = m
    const w = a.length
    for (let i = Number(a); i <= Number(b); i += Number(step || 1)) {
      names.push(pre + String(i).padStart(w, '0'))
    }
  } else names.push(s)
}
const files = names.map((n) => path.join(dir, n.endsWith('.png') ? n : n + '.png'))
for (const f of files) if (!fs.existsSync(f)) { console.log('缺帧：' + f); process.exit(1) }

const CW = 400
const imgs = files.map((f) => decodePng(fs.readFileSync(f)))
const ch = Math.round(imgs[0].height * (CW / imgs[0].width))
const cols = 2
const rows = Math.ceil(imgs.length / cols)
const W = CW * cols, H = ch * rows
const out = new Uint8Array(W * H * 4)

// 极简点阵字：只画数字和少量字母，够标帧号
const FONT = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
  f: ['111', '100', '110', '100', '100'], '.': ['000', '000', '000', '000', '010'],
  s: ['111', '100', '111', '001', '111'], '-': ['000', '000', '111', '000', '000'],
}
const put = (x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  out[i] = c; out[i + 1] = c; out[i + 2] = c; out[i + 3] = 255
}
const drawText = (txt, ox, oy, sc, col) => {
  let cx = ox
  for (const chx of txt) {
    const g = FONT[chx] || FONT['-']
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r][c] === '1') for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) put(cx + c * sc + dx, oy + r * sc + dy, col)
    }
    cx += 4 * sc
  }
}

imgs.forEach((im, k) => {
  const ox = (k % cols) * CW, oy = Math.floor(k / cols) * ch
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(im.height - 1, Math.floor(y * im.height / ch))
    for (let x = 0; x < CW; x++) {
      const sx = Math.min(im.width - 1, Math.floor(x * im.width / CW))
      const si = (sy * im.width + sx) * 4
      const di = ((oy + y) * W + ox + x) * 4
      out[di] = im.rgba[si]; out[di + 1] = im.rgba[si + 1]
      out[di + 2] = im.rgba[si + 2]; out[di + 3] = 255
    }
  }
  const label = path.parse(files[k]).name.replace(/^f0*/, '').padStart(1, '0')
  drawText(label, ox + 6, oy + 6, 4, 255)
  // 每格边框
  for (let x = 0; x < CW; x++) { put(ox + x, oy, 90); put(ox + x, oy + ch - 1, 90) }
  for (let y = 0; y < ch; y++) { put(ox, oy + y, 90); put(ox + CW - 1, oy + y, 90) }
})

const outPath = 'shots/sheet/' + specs.join('_').replace(/[^\w.-]/g, '') + '.png'
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, encodePng(W, H, out))
console.log(`${imgs.length} 帧拼成 ${W}x${H} → ${outPath}`)

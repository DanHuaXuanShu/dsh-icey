// 角色横向位置：用「青色能量像素」的质心当角色标记，输出 x 百分比。
//
//   node probe/hero-x.mjs shots/timeline/f00106.png shots/timeline/f00033.png ...
//
// 用途：判断「她是不是被右墙/左墙顶住了」。
// ⚠️ 这个口径有一个已知混淆：**战斗屏障也是青色的**，而且就在画面两侧。
//    所以它读出来的 0.05 可能只是屏障、不是人。下面的输出里同时给：
//      · 全带质心（含屏障）
//      · 掐掉左右各 8% 之后的质心（躲屏障）
//    两个数差得远，就说明这一帧被屏障带偏了，不能用。
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const BAND = { y0: 0.16, y1: 0.90 }

const isHeroCyan = (r, g, b) => {
  const lum = r * 0.299 + g * 0.587 + b * 0.114
  return lum > 110 && b > 150 && g > 120 && r < 160 && b - r > 45
}

function centroid(img, x0, x1) {
  const { width: W, height: H, rgba } = img
  const ya = Math.floor(H * BAND.y0), yb = Math.floor(H * BAND.y1)
  const xa = Math.floor(W * x0), xb = Math.ceil(W * x1)
  let sx = 0, n = 0
  for (let y = ya; y < yb; y += 2) {
    for (let x = xa; x < xb; x += 2) {
      const i = (y * W + x) * 4
      if (isHeroCyan(rgba[i], rgba[i + 1], rgba[i + 2])) { sx += x; n++ }
    }
  }
  return { x: n >= 20 ? sx / n / W : null, n }
}

for (const f of process.argv.slice(2)) {
  const img = decodePng(fs.readFileSync(f))
  const all = centroid(img, 0, 1)
  const inner = centroid(img, 0.08, 0.92)
  const fmt = (v) => (v === null ? '  —  ' : (v * 100).toFixed(0).padStart(4) + '%')
  const warn = all.x !== null && inner.x !== null && Math.abs(all.x - inner.x) > 0.10 ? '  ⚠️差得远 → 可能被屏障带偏' : ''
  console.log(
    f.padEnd(32),
    `${img.width}x${img.height}`.padEnd(10),
    '全带', fmt(all.x), `n=${String(all.n).padStart(4)}`,
    '  掐边', fmt(inner.x), `n=${String(inner.n).padStart(4)}`,
    warn,
  )
}

// 量「强化界面」的像素特征，看能不能和暂停菜单 / 普通游戏画面分开。
//
//   node probe/upgrade-menu-check.mjs
//
// 背景：2026-10-29 实测发现一件推翻既有假设的事 ——
//   强化界面打开时**血条、护盾、金钱全都还在**（HUD 没消失）。
//   也就是说 analyzer 里那条「血条/护盾/连击都不在 ⇒ 整屏界面」根本抓不到它。
//   而在这个界面里按 Enter 就是「升级」＝真的花钱，按别的键全都没用。
//   ⇒ 必须单独认出来。
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const CASES = [
  ['probe/fixtures/upgrade-menu.png', '强化界面（弥城死镇，9 项招式列表）'],
  ['probe/fixtures/station-fullframe.png', '普通游戏画面（同一场景，强化台在画面里）'],
  ['shots/watch/w0008.png', '暂停菜单（整屏压暗 92%）'],
  ['shots/combat/c0001.png', '战斗画面'],
]

const isGold = (r, g, b) => r > 150 && g > 120 && b < 110 && r - b > 60 && g - b > 40

function measure(file) {
  const img = decodePng(fs.readFileSync(file))
  const { width, height, rgba } = img
  let dark = 0, tot = 0, lumSum = 0
  // 左侧竖带（招式列表所在）：金色像素按行聚合
  const X0 = 0.08, X1 = 0.45
  const xa = Math.floor(X0 * width), xb = Math.floor(X1 * width)
  const rowGold = new Uint16Array(height)
  const rowPx = new Uint16Array(height)
  // 右侧演示区（强化界面里有一块明亮画面）
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
      if (x % 8 === 0 && y % 8 === 0) { lumSum += lum; tot++; if (lum < 60) dark++ }
    }
  }
  // 有多少行「金黄文字」够密（列表每一行都有字）
  let goldRows = 0
  for (let y = 0; y < height; y++) {
    if (rowPx[y] && rowGold[y] / rowPx[y] >= 0.02) goldRows++
  }
  return {
    file, w: width, h: height,
    darkRatio: dark / tot,
    meanLum: lumSum / tot,
    goldRows,
    boxMeanLum: boxN ? boxLum / boxN : 0,
  }
}

const rows = []
for (const [f, note] of CASES) {
  if (!fs.existsSync(f)) { console.log(`跳过 ${f}（不存在）`); continue }
  const m = measure(f)
  rows.push({ ...m, note })
}

console.log('样本'.padEnd(34) + '尺寸'.padEnd(11) + '暗占比'.padStart(8) + '均亮'.padStart(8) + '左列金行'.padStart(9) + '右中亮度'.padStart(9))
for (const r of rows) {
  console.log(
    r.file.replace('probe/fixtures/', '').replace('shots/', '').padEnd(34) +
    `${r.w}x${r.h}`.padEnd(11) +
    (r.darkRatio * 100).toFixed(1).padStart(7) + '%' +
    r.meanLum.toFixed(1).padStart(8) +
    String(r.goldRows).padStart(9) +
    r.boxMeanLum.toFixed(1).padStart(9) +
    '  ' + r.note,
  )
}
console.log('\n注意：强化界面和暂停菜单都「暗」，区别在于强化界面**左侧有一列金黄文字行**、')
console.log('      并且右边有一块明亮的演示画面 —— 而 HUD（血条/护盾/金钱）在两者里都可能还在。')

// 一次性探针：连击区到底在画面的哪一段 y？
//
// 背景：COMBO_BOX 现在是 { x0:0.075, y0:0.205, x1:0.235, y1:0.295 }，
//   但 2026-10-29 在实机截图上目测连击数字在 y≈0.11~0.13 一带，两者对不上。
//   如果框位置错了，「在战斗」这个主信号就是在量一片空区域 —— 只是恰好量到 0.000% 才没炸。
//
// 做法：把整幅画面按行统计 isComboYellow 的占比，
//   战斗帧（shots/combat）和探索帧（shots/watch）对比 ——
//   只在一侧亮的那几行，就是连击数字真正待的地方。
//
//   node probe/combo-band.mjs                # 默认两个样本集
//   node probe/combo-band.mjs shots/combat   # 只跑一个目录
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { isComboYellow, COMBO_BOX } from '../lib/games/icey/layout.mjs'

const ROWS = 100 // 把画面纵向切成 100 条来聚合

// 只统计左侧这一条竖带。全图行统计没意义 —— 探索帧的草地/光效/金色台子
// 到处都是金黄，只有「左上角这个窄框里」战斗和探索才是分开的。
const X0 = 0.02, X1 = 0.30

function bandProfile(file) {
  const img = decodePng(fs.readFileSync(file))
  const { width, height, rgba } = img
  const xa = Math.floor(X0 * width)
  const xb = Math.min(width, Math.ceil(X1 * width))
  const rowYellow = new Uint32Array(ROWS)
  const rowPx = new Uint32Array(ROWS)
  for (let y = 0; y < height; y++) {
    const band = Math.min(ROWS - 1, Math.floor((y / height) * ROWS))
    const base = y * width * 4
    for (let x = xa; x < xb; x++) {
      const i = base + x * 4
      if (isComboYellow(rgba[i], rgba[i + 1], rgba[i + 2])) rowYellow[band]++
      rowPx[band]++
    }
  }
  const ratio = new Float64Array(ROWS)
  for (let b = 0; b < ROWS; b++) ratio[b] = rowPx[b] ? rowYellow[b] / rowPx[b] : 0
  return { width, height, ratio }
}

function inBox(file, box) {
  const img = decodePng(fs.readFileSync(file))
  const { width, height, rgba } = img
  let n = 0, px = 0
  for (let y = Math.floor(box.y0 * height); y < Math.min(height, Math.ceil(box.y1 * height)); y++) {
    for (let x = Math.floor(box.x0 * width); x < Math.min(width, Math.ceil(box.x1 * width)); x++) {
      const i = (y * width + x) * 4
      if (isComboYellow(rgba[i], rgba[i + 1], rgba[i + 2])) n++
      px++
    }
  }
  return px ? n / px : 0
}

const listPng = (dir) => {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase().endsWith('.png')) out.push(p)
    }
  }
  walk(dir)
  return out
}

// 每个 band 取「正样本最大值」而不是平均 —— 连击数字是间歇出现的，
// 几百帧里只有一部分在打，平均值会把信号抹平。
function profileDir(dir, limit = 400) {
  const files = listPng(dir).slice(0, limit)
  if (!files.length) return null
  const max = new Float64Array(ROWS)
  const dims = new Map()
  for (const f of files) {
    try {
      const p = bandProfile(f)
      const k = `${p.width}x${p.height}`
      dims.set(k, (dims.get(k) || 0) + 1)
      for (let b = 0; b < ROWS; b++) if (p.ratio[b] > max[b]) max[b] = p.ratio[b]
    } catch { /* 坏图跳过 */ }
  }
  const dimStr = [...dims.entries()].map(([k, v]) => `${k}×${v}`).join(', ')
  return { dir, n: files.length, dims: dimStr, max }
}

const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['shots/combat', 'shots/watch']
const results = dirs.map((d) => profileDir(d)).filter(Boolean)
if (!results.length) { console.log('没找到样本'); process.exit(1) }

console.log('=== 样本 ===')
for (const r of results) console.log(`  ${r.dir}  ${r.n} 张  尺寸: ${r.dims}`)
const dimSets = new Set(results.map((r) => r.dims))
if (dimSets.size > 1) {
  console.log('\n⚠️ 两个目录的分辨率不同 —— ICEY 的 UI 是按像素锚定的，')
  console.log('   归一化坐标跨分辨率不可比，下面的逐带对比只能当方向参考。')
}

// 分离度 = 战斗最大 - 探索最大。只打印分离度为正的带：那才是「只在打的时候亮」的地方。
const watch = results.find((r) => /watch/.test(r.dir)) || null
const combat = results.find((r) => /combat/.test(r.dir)) || results[0]

console.log('\n=== 纵向分布（x 只在 0.02~0.30 这一条竖带里数）===')
console.log('band   y范围         战斗最大   探索最大   分离度')
const rows = []
for (let b = 0; b < ROWS; b++) {
  const c = combat.max[b]
  const w = watch ? watch.max[b] : 0
  rows.push({ b, c, w, sep: c - w })
}
// 全部打出来（有信号的），按 band 顺序 —— 好看出连击数字是一整块还是被切开
for (const r of rows) {
  if (r.c < 0.004 && r.w < 0.004) continue
  console.log(
    String(r.b).padStart(4) + '   ' +
    `${(r.b / ROWS).toFixed(2)}~${((r.b + 1) / ROWS).toFixed(2)}`.padEnd(13) +
    (r.c * 100).toFixed(2).padStart(7) + '%' +
    (r.w * 100).toFixed(2).padStart(9) + '%' +
    ((r.sep) * 100).toFixed(2).padStart(9) + '%'
  )
}

console.log('\n=== 分离度 top 15（这些带才是「只在战斗时亮」）===')
rows.sort((a, b) => b.sep - a.sep).slice(0, 15).forEach((r) => {
  console.log(
    `  band ${String(r.b).padStart(2)}  y ${(r.b / ROWS).toFixed(2)}~${((r.b + 1) / ROWS).toFixed(2)}` +
    `  战斗 ${(r.c * 100).toFixed(2)}%  探索 ${(r.w * 100).toFixed(2)}%  分离 ${(r.sep * 100).toFixed(2)}%`
  )
})

console.log('\n=== 当前 COMBO_BOX 在这两批帧上的读数 ===')
console.log('框:', JSON.stringify(COMBO_BOX))
for (const r of results) {
  const files = listPng(r.dir).slice(0, 60)
  const vals = files.map((f) => inBox(f, COMBO_BOX))
  vals.sort((a, b) => b - a)
  const top = vals.slice(0, 5).map((v) => (v * 100).toFixed(3) + '%')
  console.log(`  ${r.dir}  最高前5: ${top.join(' / ')}   中位: ${(vals[Math.floor(vals.length / 2)] * 100).toFixed(3)}%`)
}

// 敌人方位实验：能不能用「相邻帧的局部运动」把敌人在画面里的 x 找出来？
//
//   node probe/enemy-motion.mjs shots/combat3            # 成对跑完整个目录
//   node probe/enemy-motion.mjs shots/combat3 5          # 只看前 5 对
//   node probe/enemy-motion.mjs shots/combat3 3 --profile  # 打完每对的 32 列均值
//   node probe/enemy-motion.mjs shots/combat3 3 --vis      # 输出运动图（叠在后一帧上）
//
// 背景：2026-10-30 看真实战斗帧发现，战斗里相机基本是锁住的（f00106–f00156 那 50 秒
// 背景像素几乎不动），动的只有角色和特效。所以「背景静止 + 局部运动」在战斗帧里有戏。
// 之前 probe/enemy-detect 判死，用的是跳着采的截图（相邻帧差好几秒、相机还在走），
// 那批结论不能直接搬到连续帧上。
//
// 每对帧：
//   1) 40px 一格算 RGB 平均绝对差 → 运动图
//   2) 青色能量像素（艾希身上的光）定位玩家，把玩家列附近挖掉
//   3) 剩下运动最强的列 = 敌人候选列
//   4) 同时报「背景抖动基线」（最左/最右各 2 列的运动量）—— 基线越高说明相机在动，
//      这一对不可信
//
// ⚠️ 输出的是**候选**，不是事实。它必须先在眼睛能确认敌人位置的帧上对得上，
//    才谈得上进 lib/。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'

const dir = process.argv[2] || 'shots/combat3'
const limArg = process.argv.find((a) => /^\d+$/.test(a))
const SHOW_VIS = process.argv.includes('--vis')
const SHOW_PROFILE = process.argv.includes('--profile')
const LIMIT = limArg ? Number(limArg) : Infinity

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
if (files.length < 2) { console.log('至少要两张 png'); process.exit(1) }

// 内容区：窗口截图顶上有一条标题栏（约 25px），按比例切掉
const CONTENT = { y0: 0.045, y1: 0.985 }
const BAND = { y0: 0.16, y1: 0.90 }   // 只看人物所在的地面带，不含天空和 HUD
const CELL = 40                        // px（按源图分辨率）

const load = (f) => decodePng(fs.readFileSync(path.join(dir, f)))

// 每格 RGB 平均绝对差
function motionMap(a, b) {
  const W = a.width, H = a.height
  const ya = Math.floor(H * CONTENT.y0), yb = Math.floor(H * CONTENT.y1)
  const cols = Math.floor(W / CELL), rows = Math.floor((yb - ya) / CELL)
  const sum = new Float64Array(cols * rows)
  const npx = new Float64Array(cols * rows)
  for (let y = ya; y < ya + rows * CELL; y++) {
    const r = Math.floor((y - ya) / CELL)
    for (let x = 0; x < cols * CELL; x++) {
      const i = (y * W + x) * 4
      const d = Math.abs(a.rgba[i] - b.rgba[i]) + Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) + Math.abs(a.rgba[i + 2] - b.rgba[i + 2])
      const k = r * cols + Math.floor(x / CELL)
      sum[k] += d
      npx[k]++
    }
  }
  const m = new Float64Array(cols * rows)
  for (let k = 0; k < m.length; k++) m[k] = sum[k] / 3 / npx[k]
  return { m, cols, rows, ya, yb: ya + rows * CELL }
}

// 玩家：青色能量像素的质心（同 probe/track-hero.mjs 的口径）
function heroX(img) {
  const { width: W, height: H, rgba } = img
  const ya = Math.floor(H * BAND.y0), yb = Math.floor(H * BAND.y1)
  let sx = 0, n = 0
  for (let y = ya; y < yb; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > 110 && b > 150 && g > 120 && r < 160 && b - r > 45) { sx += x; n++ }
    }
  }
  return n >= 20 ? { x: sx / n / W, n } : { x: null, n }
}

// 列运动取**带内均值**，和基线同口径
// （曾经写成「求和」除以「均值」，比值被放大了十几倍）
function colProfile(mm, H) {
  const { m, cols, rows, ya } = mm
  const band = []
  for (let r = 0; r < rows; r++) {
    const y0 = (ya + r * CELL) / H
    if (y0 >= BAND.y0 && y0 <= BAND.y1) band.push(r)
  }
  const col = new Float64Array(cols)
  for (const r of band) for (let c = 0; c < cols; c++) col[c] += m[r * cols + c]
  for (let c = 0; c < cols; c++) col[c] /= band.length
  const edge = [0, 1, cols - 2, cols - 1]
  let base = 0
  for (const c of edge) for (const r of band) base += m[r * cols + c]
  base /= edge.length * band.length
  return { col, base, bandRows: band.length }
}

const pairs = Math.min(files.length - 1, LIMIT)
console.log(`目录 ${dir}｜${files.length} 帧｜分析 ${pairs} 对\n`)
console.log('对           玩家x   背景基线  候选x   列峰   次峰x   说明')

let prev = null
for (let i = 0; i < files.length - 1 && i < pairs; i++) {
  const a = prev || load(files[i])
  const b = load(files[i + 1])
  prev = b
  const mm = motionMap(a, b)
  const { col, base, bandRows } = colProfile(mm, b.height)
  const hero = heroX(b)

  const cols = col.length
  const heroCol = hero.x === null ? -1 : Math.floor(hero.x * cols)
  const masked = Array.from(col).map((v, c) => {
    const cx = c / cols
    if (cx < 0.03 || cx > 0.97) return -1
    if (heroCol >= 0 && Math.abs(c - heroCol) <= Math.max(2, Math.round(0.055 * cols))) return -1
    return v
  })
  let best = -1, bestV = -Infinity, second = -1, secondV = -Infinity
  for (let c = 0; c < cols; c++) {
    if (masked[c] < 0) continue
    if (masked[c] > bestV) { second = best; secondV = bestV; best = c; bestV = masked[c] }
    else if (masked[c] > secondV) { second = c; secondV = masked[c] }
  }
  const peak = best >= 0 ? (best + 0.5) / cols : null
  const peak2 = second >= 0 ? (second + 0.5) / cols : null
  const ratio = base > 1e-6 ? bestV / base : Infinity
  const note = ratio < 2 ? '运动弱于背景 → 相机可能在动，不可信' : (bestV < 3 ? '整体几乎没动' : '')
  console.log(
    (path.parse(files[i]).name + '→' + path.parse(files[i + 1]).name).padEnd(13),
    (hero.x === null ? ' — ' : (hero.x * 100).toFixed(0).padStart(4)) + '   ',
    base.toFixed(2).padStart(7),
    (peak === null ? '  — ' : (peak * 100).toFixed(0).padStart(4) + '%'),
    bestV.toFixed(1).padStart(6),
    (peak2 === null ? '   —' : (peak2 * 100).toFixed(0).padStart(4) + '%').padStart(8),
    note,
  )
  if (SHOW_PROFILE) {
    console.log('      列均值 ' + Array.from(col).map((v, c) => `${c}:${v.toFixed(1)}`).join(' '))
    console.log(`      带内行数 ${bandRows}`)
  }

  if (SHOW_VIS) {
    const img = b
    const out = new Uint8Array(img.width * img.height * 4)
    out.set(img.rgba)
    const { m, cols: C, rows: R, ya, yb } = mm
    let maxV = 1e-6
    for (const v of m) if (v > maxV) maxV = v
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const v = m[r * C + c] / maxV
        if (v < 0.25) continue
        for (let y = ya + r * CELL; y < ya + (r + 1) * CELL && y < img.height; y++) {
          for (let x = c * CELL; x < (c + 1) * CELL && x < img.width; x++) {
            const i = (y * img.width + x) * 4
            const k = v * v
            out[i] = Math.min(255, out[i] * (1 - k) + 255 * k)
            out[i + 1] = Math.min(255, out[i + 1] * (1 - k))
            out[i + 2] = Math.min(255, out[i + 2] * (1 - k))
          }
        }
      }
    }
    if (best >= 0) {
      for (let y = ya; y < yb; y++) {
        for (let x = best * CELL; x < (best + 1) * CELL && x < img.width; x++) {
          const i = (y * img.width + x) * 4
          if ((y - ya) % 6 < 3) { out[i] = 0; out[i + 1] = 255; out[i + 2] = 0 }
        }
      }
    }
    fs.mkdirSync('shots/motion', { recursive: true })
    const p = `shots/motion/${path.parse(files[i + 1]).name}-motion.png`
    fs.writeFileSync(p, encodePng(img.width, img.height, out))
    console.log(`   → ${p}`)
  }
}

// 「取框」工具 —— 把「猜数字 → 改代码 → 跑 probe → 看图 → 再改」变成一次圈选。
//
//   node probe/pick.mjs shots/combat/c0395.png
//   node probe/pick.mjs shots/combat/c0395.png --signal yellow
//   node probe/pick.mjs shots/combat/c0395.png --box 0.06,0.18,0.25,0.32
//   node probe/pick.mjs shots/combat --signal yellow --top 3        # 整目录投票（更稳）
//   node probe/pick.mjs shots/combat/c0395.png --html               # 出一个能拖框的网页
//
// 为什么有这个东西（2026-10-30 拆 dsh-doyourweb 之后定的）：
//   我们所有的框都是手调的数字 —— COMBO_BOX / 屏障带 / 处决黄圈 / 强化台模板，
//   每次校准要走「猜数字 → 改代码 → 跑 probe → 看图 → 再改」，一轮好几步。
//   那个插件里值得抄的只有一件事：**点一下就能拿到一块区域的坐标**。
//   它的实现（annotator.js）靠 DOM 的 getBoundingClientRect，游戏里没有 DOM，所以只能抄形状：
//   把「点元素」换成「在帧上圈一块」，把「selector」换成「归一化比例框」。
//
// 三种用法：
//   ① 只给图：在搜索范围内找信号像素聚成的最强几块，直接把框吐出来（不用圈）
//   ② 给粗框：在粗框里统计信号 → 逐边收紧 → 吐紧框（人只负责大致圈一下，精度交给工具）
//   ③ --html：生成一个可以在浏览器里拖框的页面，实时显示比例数字，圈完粘回来
//
// ⚠️ 它只算「框里有多少信号」，**不判断这个框对不对**。
//    框对不对要看裁出来的图（工具会一起输出），别只看数字。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { encodePng } from '../lib/png.mjs'
import { isComboYellow, COMBO_BOX } from '../lib/games/icey/layout.mjs'

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const target = argv[0]
if (!target || target.startsWith('--')) {
  console.log(`用法：node probe/pick.mjs <png 或 目录> [选项]

  --signal yellow|cyan|bright   找什么（默认 yellow = 连击数字那种金黄）
  --box x0,y0,x1,y1            粗框（0~1 比例）。给了就只做「收紧」，不做全图搜索
  --search x0,y0,x1,y1         搜索范围（默认按 signal 给：yellow → 左上 45%×55%）
  --top N                      输出前 N 个候选框（默认 3）
  --html                       另外生成一个能拖框的网页
  --out 目录                   输出目录（默认 shots/pick）
  --frames N                   目录模式下最多取多少帧（默认 60，均匀取样）`)
  process.exit(1)
}
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const parseBox = (s) => {
  if (!s) return null
  const [x0, y0, x1, y1] = s.split(',').map(Number)
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null
  return { x0, y0, x1, y1 }
}

const SIGNAL = arg('signal', 'yellow')
const GIVEN_BOX = parseBox(arg('box'))
const TOPN = Number(arg('top', '3'))
const WANT_HTML = argv.includes('--html')
const OUT = arg('out', 'shots/pick')
const MAX_FRAMES = Number(arg('frames', '60'))

/* ---------- 信号定义 ---------- */
// 每个信号 = 一个像素判定 + 默认搜索范围。
// 搜索范围不是"事实"，只是先验：连击数字固定在左上，屏障在两侧。
const SIGNALS = {
  yellow: {
    hint: '连击数字 / 进度条那种金黄（复用 layout.mjs 的 isComboYellow）',
    test: (r, g, b) => isComboYellow(r, g, b),
    defaultSearch: { x0: 0.03, y0: 0.03, x1: 0.48, y1: 0.58 },
  },
  cyan: {
    hint: '青色能量（屏障/剑气/角色光，也最容易互相污染）',
    test: (r, g, b) => {
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      return lum > 90 && (g + b - 2 * r) / 2 > 45 && b > 110
    },
    defaultSearch: { x0: 0.0, y0: 0.1, x1: 1.0, y1: 0.95 },
  },
  bright: {
    hint: '高亮像素（字幕、白字、爆闪）',
    test: (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114 > 200,
    defaultSearch: { x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 },
  },
}
const sig = SIGNALS[SIGNAL]
if (!sig) { console.log(`不认识的 --signal：${SIGNAL}（可选 ${Object.keys(SIGNALS).join(' / ')}）`); process.exit(1) }
const SEARCH = parseBox(arg('search')) || sig.defaultSearch

/* ---------- 图像工具 ---------- */
const load = (f) => decodePng(fs.readFileSync(f))

function maskOf(img, box) {
  const { width: W, height: H, rgba } = img
  const xa = Math.max(0, Math.floor(box.x0 * W)), xb = Math.min(W, Math.ceil(box.x1 * W))
  const ya = Math.max(0, Math.floor(box.y0 * H)), yb = Math.min(H, Math.ceil(box.y1 * H))
  const w = Math.max(0, xb - xa), h = Math.max(0, yb - ya)
  const m = new Uint8Array(w * h)
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((ya + y) * W + xa + x) * 4
      if (sig.test(rgba[i], rgba[i + 1], rgba[i + 2])) { m[y * w + x] = 1; n++ }
    }
  }
  return { m, w, h, xa, ya, n }
}

/** 框里的信号占比（就是 layout.mjs 里各种 ratioIn 的口径） */
function ratioIn(img, box) {
  const { m, w, h } = maskOf(img, box)
  return w * h ? m.reduce((a, b) => a + b, 0) / (w * h) : 0
}

/** 逐边收紧：把信号密度低于峰值 12% 的行/列裁掉 */
function tighten(img, box) {
  const mk = maskOf(img, box)
  if (!mk.n) return { box, trimmed: { left: 0, right: 0, top: 0, bottom: 0 } }
  const colSum = new Array(mk.w).fill(0), rowSum = new Array(mk.h).fill(0)
  for (let y = 0; y < mk.h; y++) for (let x = 0; x < mk.w; x++) if (mk.m[y * mk.w + x]) { colSum[x]++; rowSum[y]++ }
  const peakC = Math.max(...colSum), peakR = Math.max(...rowSum)
  // ⚠️ 门槛不能只用峰值的 12%：框很扁的时候（比如一条 3px 高的进度条），
  //    峰值只有 3，12% 就是 1 像素 —— 任何列只要沾到 1 个黄点就算"有信号"，
  //    收紧等于没做。强制至少 2 个像素。
  const minC = Math.max(2, peakC * 0.20), minR = Math.max(2, peakR * 0.20)
  let x0 = 0, x1 = mk.w - 1, y0 = 0, y1 = mk.h - 1
  while (x0 < x1 && colSum[x0] < minC) x0++
  while (x1 > x0 && colSum[x1] < minC) x1--
  while (y0 < y1 && rowSum[y0] < minR) y0++
  while (y1 > y0 && rowSum[y1] < minR) y1--
  const W = img.width, H = img.height
  const nb = {
    x0: (mk.xa + x0) / W, y0: (mk.ya + y0) / H,
    x1: (mk.xa + x1 + 1) / W, y1: (mk.ya + y1 + 1) / H,
  }
  return {
    box: nb,
    trimmed: { left: x0, right: mk.w - 1 - x1, top: y0, bottom: mk.h - 1 - y1 },
  }
}

/** 在搜索范围内找信号像素聚成的块：按行/列直方图找连续区间 */
function autoBoxes(img) {
  const mk = maskOf(img, SEARCH)
  if (!mk.n) return []
  const colSum = new Array(mk.w).fill(0), rowSum = new Array(mk.h).fill(0)
  for (let y = 0; y < mk.h; y++) for (let x = 0; x < mk.w; x++) if (mk.m[y * mk.w + x]) { colSum[x]++; rowSum[y]++ }
  // 找列方向最密的一段：滑动窗口，窗口宽 = 画面的 18%（连击区大概就这么宽）
  const winW = Math.max(8, Math.round(img.width * 0.18))
  const winWc = Math.min(mk.w, Math.round(winW * (mk.w / (img.width * (SEARCH.x1 - SEARCH.x0)))))
  let bestX = 0, bestSum = -1
  for (let x = 0; x + winWc <= mk.w; x++) {
    let s = 0
    for (let k = 0; k < winWc; k++) s += colSum[x + k]
    if (s > bestSum) { bestSum = s; bestX = x }
  }
  // 在这个窗口里找行方向的连续非空区间（允许 1 行空隙）
  const x0 = bestX, x1 = bestX + winWc - 1
  const rows = []
  let run = null
  for (let y = 0; y < mk.h; y++) {
    let s = 0
    for (let x = x0; x <= x1; x++) s += mk.m[y * mk.w + x]
    const on = s >= 2
    if (on) { if (!run) run = { a: y, b: y }; else run.b = y }
    else if (run && y - run.b > 2) { rows.push(run); run = null }
  }
  if (run) rows.push(run)
  const W = img.width, H = img.height
  const out = []
  for (const r of rows) {
    const box = {
      x0: (mk.xa + x0) / W, y0: (mk.ya + r.a) / H,
      x1: (mk.xa + x1 + 1) / W, y1: (mk.ya + r.b + 1) / H,
    }
    // 数一下这个框里有多少信号像素，按它排序
    const { n } = maskOf(img, box)
    out.push({ box, pixels: n, area: (box.x1 - box.x0) * (box.y1 - box.y0) })
  }
  out.sort((a, b) => b.pixels - a.pixels)
  return out.slice(0, TOPN)
}

/* ---------- 输出 ---------- */
const fmt = (b) => `{ x0: ${b.x0.toFixed(3)}, y0: ${b.y0.toFixed(3)}, x1: ${b.x1.toFixed(3)}, y1: ${b.y1.toFixed(3)} }`
const pct = (v) => `${(v * 100).toFixed(2)}%`

function writeCrop(img, box, name, scale = 4) {
  const xa = Math.max(0, Math.floor(box.x0 * img.width)), xb = Math.min(img.width, Math.ceil(box.x1 * img.width))
  const ya = Math.max(0, Math.floor(box.y0 * img.height)), yb = Math.min(img.height, Math.ceil(box.y1 * img.height))
  const cw = Math.max(1, xb - xa), ch = Math.max(1, yb - ya)
  const W = cw * scale, H = ch * scale
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = ((ya + Math.floor(y / scale)) * img.width + (xa + Math.floor(x / scale))) * 4
      const di = (y * W + x) * 4
      out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]; out[di + 2] = img.rgba[si + 2]; out[di + 3] = 255
    }
  }
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, name)
  fs.writeFileSync(p, encodePng(W, H, out))
  return p
}

/** 整帧 + 红框：用来确认框在哪（数字对不代表框对） */
function writeOverlay(img, boxes, name) {
  const out = new Uint8Array(img.rgba)
  const draw = (b, col) => {
    const xa = Math.max(0, Math.floor(b.x0 * img.width)), xb = Math.min(img.width - 1, Math.ceil(b.x1 * img.width))
    const ya = Math.max(0, Math.floor(b.y0 * img.height)), yb = Math.min(img.height - 1, Math.ceil(b.y1 * img.height))
    const put = (x, y) => { const i = (y * img.width + x) * 4; out[i] = col[0]; out[i + 1] = col[1]; out[i + 2] = col[2] }
    for (let x = xa; x <= xb; x++) { put(x, ya); put(x, yb) }
    for (let y = ya; y <= yb; y++) { put(xa, y); put(xb, y) }
  }
  boxes.forEach((b, k) => draw(b, k === 0 ? [255, 40, 40] : k === 1 ? [40, 200, 255] : [255, 200, 40]))
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, name)
  fs.writeFileSync(p, encodePng(img.width, img.height, out))
  return p
}

/* ---------- 主流程 ---------- */
const files = []
if (fs.statSync(target).isDirectory()) {
  const all = fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.png')).sort()
  const step = Math.max(1, Math.floor(all.length / MAX_FRAMES))
  for (let i = 0; i < all.length && files.length < MAX_FRAMES; i += step) files.push(path.join(target, all[i]))
} else files.push(target)

console.log(`信号 ${SIGNAL} —— ${sig.hint}`)
console.log(`帧 ${files.length} 张｜搜索范围 ${JSON.stringify(SEARCH)}`)
if (SIGNAL === 'yellow') console.log(`当前 COMBO_BOX  ${fmt(COMBO_BOX)}  （读数 ${pct(ratioIn(load(files[0]), COMBO_BOX))}，阈值 0.60%）`)
console.log('')

// ① 全图搜索（没给粗框时）
let candidates = []
if (!GIVEN_BOX) {
  for (const f of files) candidates.push(...autoBoxes(load(f)))
  if (!candidates.length) {
    console.log('搜索范围里没有信号像素。（--signal 或 --search 选错了吧）')
    process.exit(0)
  }
  // 多帧投票分两步，别直接对全部候选取中位数：
  //   ① 先按「y 中心」聚类 —— 连击数字、护盾黄格、金币数字都可能是黄的，
  //      它们分别落在不同的高度带上，混在一起取中位数会得到一个谁都不是的框
  //      （第一次跑就是这么错的：0.153 那条和 0.298 那条被平均成了 0.271~0.303）
  //   ② 选信号像素总数最多的那一簇，只在簇内取中位数
  const usable = candidates.filter((c) => c.pixels >= 8)
  if (!usable.length) { console.log('信号太弱（没有一帧的候选框超过 8 个像素）。'); process.exit(0) }
  const clusters = []
  for (const c of usable) {
    const yc = (c.box.y0 + c.box.y1) / 2
    const hit = clusters.find((g) => Math.abs(g.yc - yc) < 0.025)
    if (hit) { hit.items.push(c); hit.yc = (hit.yc * (hit.items.length - 1) + yc) / hit.items.length }
    else clusters.push({ yc, items: [c] })
  }
  clusters.sort((a, b) => b.items.reduce((s, c) => s + c.pixels, 0) - a.items.reduce((s, c) => s + c.pixels, 0))
  const chosen = clusters[0]
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]
  const pick1 = (k) => med(chosen.items.map((c) => c.box[k]))
  const merged = { x0: pick1('x0'), y0: pick1('y0'), x1: pick1('x1'), y1: pick1('y1') }
  const first = load(files[0])
  const t = tighten(first, merged)

  // 裁图/叠图必须用**信号最强的那一帧**，不能用 files[0]。
  // 第一次跑就是在这里翻车的：框是从 48 帧里投票出来的，但裁图用了第一帧，
  // 那一帧根本没有连击 → 裁出来是一条空背景，看图和看数字互相矛盾。
  let bestFile = files[0], bestRatio = -1, bestImg = first
  for (const f of files) {
    const img = load(f)
    const r = ratioIn(img, t.box)
    if (r > bestRatio) { bestRatio = r; bestFile = f; bestImg = img }
  }

  console.log(`=== 高度带（按信号像素聚类，共 ${clusters.length} 簇）===`)
  for (const g of clusters.slice(0, TOPN)) {
    const gb = {
      x0: med(g.items.map((c) => c.box.x0)), y0: med(g.items.map((c) => c.box.y0)),
      x1: med(g.items.map((c) => c.box.x1)), y1: med(g.items.map((c) => c.box.y1)),
    }
    const px = g.items.reduce((s, c) => s + c.pixels, 0)
    console.log(`  ${g === chosen ? '★' : ' '} ${fmt(gb)}  ${String(px).padStart(6)} 像素 / ${g.items.length} 帧命中`)
  }
  console.log(`\n=== 选中的框（收紧前）===\n${fmt(merged)}`)
  console.log(`=== 收紧后 ===\n${fmt(t.box)}   裁掉 左${t.trimmed.left} 右${t.trimmed.right} 上${t.trimmed.top} 下${t.trimmed.bottom} 像素`)

  // 关键对比：**在整批帧上**分别量旧框和新框 —— 只看第一帧会得出 0.00% 对 0.00% 这种废话
  if (SIGNAL === 'yellow') {
    const stat = (box) => {
      const rs = []
      for (const f of files) rs.push(ratioIn(load(f), box))
      const hitFrames = rs.filter((r) => r > 0).length
      const over = rs.filter((r) => r >= 0.006).length
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length
      return { hitFrames, over, avg, max: Math.max(...rs) }
    }
    const o = stat(COMBO_BOX), n = stat(t.box)
    console.log(`\n=== 整批 ${files.length} 帧上的读数对比 ===`)
    console.log(`            有信号帧   过线帧(≥0.60%)   平均      最大`)
    console.log(`  旧框      ${String(o.hitFrames).padStart(5)}      ${String(o.over).padStart(5)}        ${pct(o.avg).padStart(7)}  ${pct(o.max)}`)
    console.log(`  紧框      ${String(n.hitFrames).padStart(5)}      ${String(n.over).padStart(5)}        ${pct(n.avg).padStart(7)}  ${pct(n.max)}`)
    console.log(`\n面积 ${pct((COMBO_BOX.x1 - COMBO_BOX.x0) * (COMBO_BOX.y1 - COMBO_BOX.y0))} → ${pct((t.box.x1 - t.box.x0) * (t.box.y1 - t.box.y0))}`)
    if (n.hitFrames > o.hitFrames) console.log(`紧框多认出 ${n.hitFrames - o.hitFrames} 帧有信号 —— 旧框漏掉的那些`)
    if (n.hitFrames < o.hitFrames) console.log(`⚠️ 紧框少认出 ${o.hitFrames - n.hitFrames} 帧 —— 可能框歪了，看裁图`)
  }
  console.log(`\n=== 最有代表的一帧：${path.basename(bestFile)}（框内读数 ${pct(bestRatio)}）===`)
  // 把框里被当成信号的像素的 RGB 打印出来 —— 这一步能把「连击金黄」和「土黄背景」分开。
  // 只看到 19% / 33% 这种数字是没有意义的：可能量的是背景。
  {
    const mk = maskOf(bestImg, t.box)
    const hist = new Map()
    for (let y = 0; y < mk.h; y++) for (let x = 0; x < mk.w; x++) {
      if (!mk.m[y * mk.w + x]) continue
      const i = ((mk.ya + y) * bestImg.width + mk.xa + x) * 4
      const k = `${bestImg.rgba[i]},${bestImg.rgba[i + 1]},${bestImg.rgba[i + 2]}`
      hist.set(k, (hist.get(k) || 0) + 1)
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    console.log(`  框内颜色（前 5）：${top.map(([c, n]) => `rgb(${c})×${n}`).join('  ')}`)
  }
  console.log(`\n粘贴用：${fmt(t.box)}`)
  console.log(`裁图 ${writeCrop(bestImg, t.box, `pick-${SIGNAL}-crop.png`)}`)
  console.log(`叠框 ${writeOverlay(bestImg, [t.box, merged], `pick-${SIGNAL}-overlay.png`)}`)
}

// ② 给了粗框：只收紧
if (GIVEN_BOX) {
  const first = load(files[0])
  const t = tighten(first, GIVEN_BOX)
  console.log('=== 粗框 ===\n' + fmt(GIVEN_BOX) + `   读数 ${pct(ratioIn(first, GIVEN_BOX))}`)
  console.log('=== 收紧后 ===\n' + fmt(t.box) + `   读数 ${pct(ratioIn(first, t.box))}`)
  console.log(`裁掉 左${t.trimmed.left} 右${t.trimmed.right} 上${t.trimmed.top} 下${t.trimmed.bottom} 像素`)
  console.log(`\n粘贴用：${fmt(t.box)}`)
  console.log(`裁图 ${writeCrop(first, t.box, `pick-${SIGNAL}-crop.png`)}`)
  console.log(`叠框 ${writeOverlay(first, [t.box, GIVEN_BOX], `pick-${SIGNAL}-overlay.png`)}`)
}

// ③ 生成可以拖框的网页
if (WANT_HTML) {
  const f = files[0]
  const b64 = fs.readFileSync(f).toString('base64')
  const mime = 'image/png'
  const html = `<!doctype html><meta charset="utf-8"><title>取框 · ${path.basename(f)}</title>
<style>
 body{margin:0;background:#15181b;color:#dfe6e9;font:14px/1.6 system-ui,sans-serif}
 header{padding:10px 14px;background:#1d2226;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
 code{background:#0d1012;padding:3px 8px;border-radius:5px;color:#8ee6a8;font-size:13px}
 #wrap{position:relative;display:inline-block;margin:14px;cursor:crosshair;user-select:none}
 img{display:block;max-width:calc(100vw - 60px)}
 #box{position:absolute;border:2px solid #ff4d4d;background:#ff4d4d22;display:none;pointer-events:none}
 #hint{padding:0 14px;color:#8b9aa3}
</style>
<header>
 <strong>拖一个框</strong>
 <span>x0..y1 = <code id="v">—</code></span>
 <span id="why"></span>
</header>
<div id="hint">在图上按住左键拖出矩形；松手后上面的数字就是能粘进 layout.mjs 的比例框。</div>
<div id="wrap"><img id="img" src="data:${mime};base64,${b64}"><div id="box"></div></div>
<script>
 const img=document.getElementById('img'), box=document.getElementById('box'), out=document.getElementById('v')
 let sx=0, sy=0, dragging=false
 const ratio=(e)=>{const r=img.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}}
 const paint=(a,b)=>{const wrap=document.getElementById('wrap'),ir=img.getBoundingClientRect(),wr=wrap.getBoundingClientRect()
   box.style.display='block';box.style.left=(Math.min(a.x,b.x)*ir.width)+'px';box.style.top=(Math.min(a.y,b.y)*ir.height)+'px'
   box.style.width=(Math.abs(a.x-b.x)*ir.width)+'px';box.style.height=(Math.abs(a.y-b.y)*ir.height)+'px'}
 img.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=true;sx=e;const p=ratio(e);paint(p,p);img.setPointerCapture(e.pointerId)})
 img.addEventListener('pointermove',e=>{if(dragging)paint(ratio(sx),ratio(e))})
 img.addEventListener('pointerup',e=>{if(!dragging)return;dragging=false
   const a=ratio(sx),b=ratio(e)
   const b2={x0:Math.min(a.x,b.x),y0:Math.min(a.y,b.y),x1:Math.max(a.x,b.x),y1:Math.max(a.y,b.y)}
   out.textContent=\`{ x0: \${b2.x0.toFixed(3)}, y0: \${b2.y0.toFixed(3)}, x1: \${b2.x1.toFixed(3)}, y1: \${b2.y1.toFixed(3)} }\`
   navigator.clipboard?.writeText(out.textContent).catch(()=>{})
   document.getElementById('why').textContent='（已尝试复制）'})
</script>`
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, 'pick.html')
  fs.writeFileSync(p, html, 'utf8')
  console.log(`\n拖框页面：${path.resolve(p)}`)
  console.log('打开后拖一个框，数字会自动算好并尝试复制，粘回来即可。')
}

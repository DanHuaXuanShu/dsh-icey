// 判据体检：给现有每个像素判据算「它到底分不分得开正负样本」。
//
//   node probe/fit.mjs                                  # 默认：用时间轴的逐帧标签
//   node probe/fit.mjs --n 600                          # 抽 600 帧（快）
//   node probe/fit.mjs --pos shots/combat --neg shots/watch   # 退回「按目录分组」的老模式
//
// 为什么有这个东西（2026-10-31 拆 dsh-game-stack 之后定的）：
//   那个仓库的 `compile.py` 里有个 `_fit(pos_est, neg_vals, ...)`，docstring 一句话说穿了：
//     「在正样本估计和负样本最坏情况之间切开。返回 (tau, gap)。
//       gap <= MIN_GAP 表示这个特征分不开正负样本 —— 不可判别。」
//   我们所有阈值（COMBO_MIN / BARRIER_CYAN_MIN / SUBTITLE_MIN / VFX_DANGER …）都是手填的，
//   而且**从来没有任何东西告诉我们某个判据是不是在骗人**。
//
// 输出四样：
//   pos_p95 / neg_p99   正样本的高分位 vs 负样本的最坏情况（_fit 的两端）
//   gap                 pos_p95 - neg_p99；≤0 = 分不开
//   AUC                 随便抽一正一负，正样本分数更高的概率（0.5 = 瞎猜，1.0 = 完美）
//   TPR / FPR           当前手填阈值实际的效果
//
// ⚠️⚠️ 两个必须说清的坑（都是我自己第一版踩过的）⚠️⚠️
//
// 坑一：**每条判据只能在自己该预测的标签上打分。**
//   第一版用同一对正/负目录（战斗 vs 游荡）去考所有判据，结论几乎全是「不可判别」——
//   那不是判据坏了，是实验设计错了：
//     · 血条 / HUD / 护盾 在整个游戏里一直都在，它们预测的是「游戏开着」，不是「在战斗」
//     · 字幕预测的是「在念旁白」
//     · 画面爆闪预测的是「大伤害前的高亮」，不是「战斗」
//   拿「战斗 vs 游荡」去考它们当然分不开。现在每条判据声明自己 predict 什么，
//   只在对应的标签上被打分；考不了的明确写「无独立标签」。
//
// 坑二：**不能用含有自己的标签给自己打分（循环论证）。**
//   「在战斗」这个标签如果定义成「连击 or 屏障 or 掉血」，那屏障的 AUC 就必接近 1，
//   因为标签里含它自己。所以这里「在战斗」只用 **连击 or 掉血**，
//   屏障作为被考对象**不进标签** —— 这样量出来的才是真本事。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import {
  COMBO_BOX, COMBO_MIN, isComboYellow,
  HUD_BOX, HUD_LUM_MIN,
  PROMPT_BOX, PROMPT_LUM_MIN,
  SUBTITLE_BOX, SUBTITLE_MIN, SUBTITLE_LUM_MIN,
  VFX_LUM_MIN, VFX_DANGER,
  HP_BOX, SHIELD_BOX,
} from '../lib/games/icey/layout.mjs'

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const N = Number(arg('n', '0'))              // 0 = 全部
const DIR_PAIRS = arg('pos', '') && arg('neg', '')
  ? { pos: arg('pos'), neg: arg('neg') }
  : null
const TIMELINE = 'probe/output/fight-timeline.json'
const FRAMES = 'shots/timeline'

/* ---------- 像素工具 ---------- */
function boxPixels(W, H, box) {
  return {
    xa: Math.max(0, Math.floor(box.x0 * W)), xb: Math.min(W, Math.ceil(box.x1 * W)),
    ya: Math.max(0, Math.floor(box.y0 * H)), yb: Math.min(H, Math.ceil(box.y1 * H)),
  }
}
function ratioBox(rgba, W, H, box, test, step = 1) {
  const { xa, xb, ya, yb } = boxPixels(W, H, box)
  let n = 0, px = 0
  for (let y = ya; y < yb; y += step) {
    for (let x = xa; x < xb; x += step) {
      const i = (y * W + x) * 4
      if (test(rgba[i], rgba[i + 1], rgba[i + 2])) n++
      px++
    }
  }
  return px ? n / px : 0
}
function brightRatio(rgba, W, H, lumMin, step = 4) {
  let n = 0, px = 0
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4
      if (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 >= lumMin) n++
      px++
    }
  }
  return px ? n / px : 0
}

// 屏障：左右各取最外侧 3% 宽、y 0.20~0.85，量青色 (g+b-2r)/2 的均值。
// 口径必须和 lib/autoplay.mjs 的 analyzeEnvironment 一致，否则体检的不是同一个判据。
const BARRIER_BAND = 0.03
const BARRIER_CYAN_MIN = 55
const BARRIER_LUM_MIN = 40
function barrierCyan(rgba, W, H, side) {
  const xa = side === 'left' ? 0 : Math.floor(W * (1 - BARRIER_BAND))
  const xb = side === 'left' ? Math.floor(W * BARRIER_BAND) : W
  const ya = Math.floor(H * 0.20), yb = Math.floor(H * 0.85)
  let sum = 0, n = 0
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum < BARRIER_LUM_MIN) continue
      sum += (g + b - 2 * r) / 2
      n++
    }
  }
  return n ? sum / n / 255 : 0
}
const lum = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114

/* ---------- 判据表 ---------- */
// predict 决定它跟哪个标签比。可选：combat / hit / hurt / hud / subtitle / prompt / vfx / shield / none
const CRITERIA = [
  {
    id: 'barrierL', name: '屏障·左', cur: BARRIER_CYAN_MIN / 255, predict: 'combat',
    note: '左右各 3% 带内青色均值（标签不含屏障本身 ⇒ 非循环）',
    measure: (a, W, H) => barrierCyan(a, W, H, 'left'),
  },
  {
    id: 'barrierR', name: '屏障·右', cur: BARRIER_CYAN_MIN / 255, predict: 'combat',
    note: '同上',
    measure: (a, W, H) => barrierCyan(a, W, H, 'right'),
  },
  {
    id: 'combo', name: '连击框（黄）', cur: COMBO_MIN, predict: 'hit',
    circular: true,
    note: 'COMBO_BOX；标签「打中」就是连击亮 — 这条**本质上是循环的**，只当参考，别当成"AUC 1.0 所以判据很好"',
    measure: (a, W, H) => ratioBox(a, W, H, COMBO_BOX, isComboYellow),
  },
  {
    id: 'vfx', name: '画面爆闪', cur: VFX_DANGER, predict: 'hurt',
    note: '整帧亮度≥210 的占比；预测「这一秒掉血了」',
    measure: (a, W, H) => brightRatio(a, W, H, VFX_LUM_MIN),
  },
  {
    id: 'hud', name: 'HUD 亮像素', cur: null, predict: 'none',
    note: 'HUD_BOX 里亮度≥150 的占比 — 预测「游戏画面在」，这批数据里没有这个标签',
    measure: (a, W, H) => ratioBox(a, W, H, HUD_BOX, (r, g, b) => lum(r, g, b) >= HUD_LUM_MIN),
  },
  {
    id: 'hpbar', name: '血条亮段', cur: null, predict: 'none',
    note: 'HP_BOX 里亮度≥150 — 同上，预测画面在不在',
    measure: (a, W, H) => ratioBox(a, W, H, HP_BOX, (r, g, b) => lum(r, g, b) >= HUD_LUM_MIN),
  },
  {
    id: 'shield', name: '护盾黄格', cur: null, predict: 'none',
    note: 'SHIELD_BOX 里黄色占比 — 预测「护盾还在」，没有独立标签',
    measure: (a, W, H) => ratioBox(a, W, H, SHIELD_BOX, isComboYellow),
  },
  {
    id: 'subtitle', name: '字幕白字', cur: SUBTITLE_MIN, predict: 'none',
    note: '预测「在念旁白」，这批数据里没有字幕标签',
    measure: (a, W, H) => ratioBox(a, W, H, SUBTITLE_BOX, (r, g, b) => lum(r, g, b) >= SUBTITLE_LUM_MIN),
  },
  {
    id: 'prompt', name: '提示框白字', cur: null, predict: 'none',
    note: '预测「有交互提示」，没有独立标签',
    measure: (a, W, H) => ratioBox(a, W, H, PROMPT_BOX, (r, g, b) => lum(r, g, b) >= PROMPT_LUM_MIN),
  },
]

/* ---------- 统计 ---------- */
const q = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
/** 秩和法 AUC：P(正 > 负)，同分取平均秩 */
function auc(pos, neg) {
  const n1 = pos.length, n2 = neg.length
  if (!n1 || !n2) return NaN
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0])
  let rankSumPos = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++
    const avgRank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSumPos += avgRank
    i = j + 1
  }
  return (rankSumPos - (n1 * (n1 + 1)) / 2) / (n1 * n2)
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—')
const num = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '—')

/* ---------- 模式一：时间轴逐帧标签 ---------- */
function runTimeline() {
  if (!fs.existsSync(TIMELINE)) {
    console.log(`没有时间轴数据：${TIMELINE}\n先跑 node probe/fight-timeline.mjs 生成。`)
    return
  }
  const tl = JSON.parse(fs.readFileSync(TIMELINE, 'utf8'))
  const rows = tl.rows
  const step = N > 0 ? Math.max(1, Math.floor(rows.length / N)) : 1
  const pick = rows.filter((_, i) => i % step === 0)

  console.log(`判据体检（时间轴逐帧标签）：${pick.length} / ${rows.length} 帧，${FRAMES}`)
  console.log('标签口径：在战斗 = 连击亮 or 掉血（**不含屏障**,避免循环）；打中 = 连击亮；掉血 = 这一秒血/盾掉了')
  console.log('')

  // 每帧只解码一次，所有判据同一趟算完（第一版每判据各自解码 400 张 → OOM）
  const vals = new Map(CRITERIA.map((c) => [c.id, []]))
  const labels = []
  let done = 0
  for (const r of pick) {
    const f = path.join(FRAMES, r.file)
    if (!fs.existsSync(f)) continue
    const im = decodePng(fs.readFileSync(f))
    // 标签一律取自时间轴 JSON（那里是按「comboOn / hurt」算好的），
    // 只有 combat 在这里现拼，且刻意排除 barrier
    labels.push({
      combat: !!(r.comboOn || r.hurt),
      hit: !!r.comboOn,
      hurt: !!r.hurt,
      anyFalse: !(r.comboOn || r.barrier || r.hurt),
    })
    for (const c of CRITERIA) vals.get(c.id).push(c.measure(im.rgba, im.width, im.height))
    if (++done % 200 === 0) process.stdout.write(`\r  解码 ${done}/${pick.length}`)
  }
  process.stdout.write(`\r  解码 ${done} 帧完成\n\n`)

  const nCombat = labels.filter((l) => l.combat).length
  const nHit = labels.filter((l) => l.hit).length
  const nHurt = labels.filter((l) => l.hurt).length
  const nAllFalse = labels.filter((l) => l.anyFalse).length
  console.log(`标签分布：在战斗 ${nCombat} / 打中 ${nHit} / 掉血 ${nHurt} / 三信号全假 ${nAllFalse}`)
  console.log('')

  console.log('判据'.padEnd(12) + '对什么'.padEnd(9) + 'pos_p95  neg_p99  gap      AUC    现阈值  TPR     FPR     结论')
  console.log('-'.repeat(104))
  for (const c of CRITERIA) {
    const v = vals.get(c.id)
    if (c.predict === 'none') {
      console.log(
        c.name.padEnd(12) + '—'.padEnd(9) +
        num(q(v, 0.95)).padEnd(9) + num(q(v, 0.01)).padEnd(9) +
        '—'.padEnd(9) + '—'.padEnd(8) +
        (c.cur === null ? '—'.padEnd(8) : num(c.cur, 3).padEnd(8)) +
        '—'.padEnd(8) + '—'.padEnd(9) + '无独立标签',
      )
      continue
    }
    const pos = [], neg = []
    for (let i = 0; i < v.length; i++) (labels[i][c.predict] ? pos : neg).push(v[i])
    const posP95 = q(pos, 0.95), negP99 = q(neg, 0.99)
    const gap = posP95 - negP99
    const a = auc(pos, neg)
    let tpr = NaN, fpr = NaN
    if (c.cur !== null) {
      tpr = pos.filter((x) => x >= c.cur).length / (pos.length || 1)
      fpr = neg.filter((x) => x >= c.cur).length / (neg.length || 1)
    }
    let verdict
    if (!Number.isFinite(a)) verdict = '数据不足'
    else if (a < 0.55) verdict = '❌ 不可判别'
    else if (a < 0.70) verdict = '⚠️ 勉强'
    else if (a < 0.85) verdict = '✅ 可用'
    else verdict = '✅✅ 好'
    const labelName = { combat: '在战斗', hit: '打中', hurt: '掉血' }[c.predict] || c.predict
    console.log(
      c.name.padEnd(12) + labelName.padEnd(9) +
      num(posP95).padEnd(9) + num(negP99).padEnd(9) +
      (gap > 0 ? '+' : '') + num(gap).padEnd(9) +
      num(a, 3).padEnd(8) +
      (c.cur === null ? '—'.padEnd(8) : num(c.cur, 3).padEnd(8)) +
      pct(tpr).padEnd(8) + pct(fpr).padEnd(9) + verdict,
    )
    c._diag = { posP95, negP99, gap, auc: a, tpr, fpr, nPos: pos.length, nNeg: neg.length, pos, neg }
  }

  console.log('\n=== 细节（只列 AUC < 0.85 的）===')
  for (const c of CRITERIA) {
    const d = c._diag
    if (!d || d.auc >= 0.85) continue
    const fitTau = d.negP99 + Math.max(0, d.gap) * 0.25
    console.log(`\n${c.name}（${c.note}）`)
    console.log(`  正 p50/p95/max = ${num(q(d.pos, 0.5))} / ${num(d.posP95)} / ${num(Math.max(...d.pos))}   (n=${d.nPos})`)
    console.log(`  负 p50/p99/max = ${num(q(d.neg, 0.5))} / ${num(d.negP99)} / ${num(Math.max(...d.neg))}   (n=${d.nNeg})`)
    if (Number.isFinite(fitTau) && fitTau > 0) {
      const t2 = d.pos.filter((v) => v >= fitTau).length / d.pos.length
      const f2 = d.neg.filter((v) => v >= fitTau).length / d.neg.length
      console.log(`  按 _fit 口径切在 ${num(fitTau)}：TPR ${pct(t2)} / FPR ${pct(f2)}${f2 > 0.2 ? '  ⚠️ 误报偏高' : ''}`)
    }
  }
}

/* ---------- 模式二：按目录分组（老办法，弱标签） ---------- */
function runDirs() {
  const load = (f) => decodePng(fs.readFileSync(f))
  const sample = (dir) => {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
    const step = Math.max(1, Math.floor(files.length / (N || 120)))
    return files.filter((_, i) => i % step === 0).slice(0, N || 120).map((f) => path.join(dir, f))
  }
  const posFiles = sample(DIR_PAIRS.pos)
  const negFiles = sample(DIR_PAIRS.neg)
  console.log(`按目录分组（弱标签）：正 ${posFiles.length}（${DIR_PAIRS.pos}） vs 负 ${negFiles.length}（${DIR_PAIRS.neg}）`)
  console.log('⚠️ 这是弱标签：watch 里混着真战斗帧，而且「在战斗 vs 在游荡」对 HUD/字幕/血条没有意义。\n')

  const vals = new Map(CRITERIA.map((c) => [c.id, []]))
  const run = (files) => {
    for (const f of files) {
      const im = load(f)
      for (const c of CRITERIA) vals.get(c.id).push(c.measure(im.rgba, im.width, im.height))
    }
  }
  run(posFiles)
  const posVals = new Map([...vals].map(([k, v]) => [k, [...v]]))
  for (const v of vals.values()) v.length = 0
  run(negFiles)

  console.log('判据'.padEnd(12) + 'pos_p95  neg_p99  AUC    结论')
  console.log('-'.repeat(52))
  for (const c of CRITERIA) {
    const p = posVals.get(c.id), n = vals.get(c.id)
    const a = auc(p, n)
    let verdict
    if (!Number.isFinite(a)) verdict = '数据不足'
    else if (a < 0.55) verdict = '❌ 不可判别'
    else if (a < 0.70) verdict = '⚠️ 勉强'
    else if (a < 0.85) verdict = '✅ 可用'
    else verdict = '✅✅ 好'
    console.log(c.name.padEnd(12) + num(q(p, 0.95)).padEnd(9) + num(q(n, 0.99)).padEnd(9) + num(a, 3).padEnd(7) + verdict)
  }
}

if (DIR_PAIRS) runDirs()
else runTimeline()

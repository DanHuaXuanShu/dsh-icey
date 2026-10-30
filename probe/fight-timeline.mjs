// 从录像时间轴重建「战斗/非战斗」标签，检验各个「在战斗」信号的真实覆盖率。
//
//   node probe/fight-timeline.mjs
//
// 背景：之前拿 shots/combat 和 shots/watch 当正负样本组，但那两组是按采集时段分的，
// 里混着战斗和非战斗（watch/w0134 是 47 连击的真实战斗帧），所以算出来的
// 「召回 27% / 假阳 13.4%」是假标签上的数字。
//
// 这份脚本换成**同一条时间轴上的连续帧**（1 fps，从整段 2422 秒录像抽出）。
//
// ⚠️ 标签仍然是「下界」而不是真值，原因（用户 2026-10-30 说明的游戏机制）：
//    连击数字在「没打中 / 破盾受击 / 受击」三种情况下都会消失，
//    所以「看不到连击」推不出「不在战斗」。同理，「没屏障 + 没掉血 + 没连击」
//    的时刻里，有一部分其实是「在战斗但打空且没挨打」。因此：
//      · 「确定在战斗」（三信号任一为真）是可靠的下界 → 可以用来算**覆盖率**（漏没漏）
//      · 「三信号全假」不等于「确定不在战斗」 → 不能直接当负样本算误报率
//    要算误报率，得人工标一段。
//
// ⚠️ 另外两条口径限制：
//    · 1 fps 抽帧 ⇒ 这里的 motion 是「相隔 1 秒」的变化率，实机决策间隔约 0.2~0.7 秒，
//      所以这里的 motion 数值不能直接当阈值用，只能看**相对高低**。
//    · 帧缩到 640 宽，边缘类判据（屏障）在这之前已经验证过缩放后仍可用。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame, analyzeEnvironment, COMBO_MIN } from '../lib/autoplay.mjs'

const DIR = 'shots/timeline'
const OUT = 'probe/output/fight-timeline.json'

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort()
  : []
if (!files.length) {
  console.log(`没有帧：${DIR}（先用 ffmpeg -vf fps=1,scale=640:-1 抽）`)
  process.exit(0)
}

const rows = []
let prev = null
const t0 = Date.now()
for (let i = 0; i < files.length; i++) {
  const f = files[i]
  const im = decodePng(fs.readFileSync(path.join(DIR, f)))
  const m = analyzeFrame(im.rgba, im.width, im.height, prev)
  const e = analyzeEnvironment(im.rgba, im.width, im.height)
  rows.push({
    t: i,                                   // 文件名 f%05d 从 1 开始 ⇒ 第 i 帧 ≈ 第 i 秒
    file: f,
    combo: m.combo ?? 0,
    comboOn: (m.combo ?? 0) >= COMBO_MIN,
    barrier: e.barrier === true,
    edge: e.barrierEdge,
    hp: typeof m.hp === 'number' ? m.hp : null,
    shield: typeof m.shield === 'number' ? m.shield : null,
    motion: m.motion ?? null,
  })
  prev = { rgba: im.rgba, width: im.width, height: im.height }
  if (i % 300 === 0) process.stdout.write(`\r  ${i}/${files.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}
process.stdout.write(`\r  分析完成 ${files.length} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)

// 掉血/破盾：和上一帧比，掉了 2 个百分点以上
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i]
  const hpDown = a.hp !== null && b.hp !== null && (a.hp - b.hp) > 0.02
  const shDown = a.shield !== null && b.shield !== null && (a.shield - b.shield) > 0.02
  b.hurt = hpDown || shDown
}
rows[0].hurt = false

// 「确定在战斗」的下界
for (const r of rows) r.combat = r.comboOn || r.barrier || r.hurt

const n = rows.length
const pct = (k) => ((rows.filter((r) => r[k]).length / n) * 100).toFixed(1)
console.log(`\n总帧数 ${n}（1 fps ⇒ 约 ${(n / 60).toFixed(0)} 分钟）`)
console.log(`  连击可见 combo>=${COMBO_MIN}  ${pct('comboOn')}%`)
console.log(`  战斗屏障 barrier            ${pct('barrier')}%`)
console.log(`  掉血/破盾 hurt              ${pct('hurt')}%`)
console.log(`  以上任一 = 确定在战斗        ${pct('combat')}%`)

// 合并成区间（间隔 <= 3 秒算同一段）
const segs = []
let cur = null
for (const r of rows) {
  if (r.combat) {
    if (cur && r.t - cur.end <= 3) cur.end = r.t
    else { cur = { start: r.t, end: r.t }; segs.push(cur) }
  }
}
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
console.log(`\n确定在战斗的区间 ${segs.length} 段，共 ${segs.reduce((a, s) => a + (s.end - s.start + 1), 0)} 秒：`)
for (const s of segs.slice(0, 40)) {
  const len = s.end - s.start + 1
  if (len < 2) continue
  const inSeg = rows.slice(s.start, s.end + 1)
  const cov = (k) => ((inSeg.filter((r) => r[k]).length / inSeg.length) * 100).toFixed(0)
  console.log(`  ${mmss(s.start)}–${mmss(s.end)}  ${String(len).padStart(3)}s` +
    `  连击 ${cov('comboOn').padStart(3)}%  屏障 ${cov('barrier').padStart(3)}%  掉血 ${cov('hurt').padStart(3)}%`)
}
if (segs.filter((s) => s.end - s.start + 1 >= 2).length > 40) console.log('  …（更多略）')

// 段落内部：三种信号各自的覆盖（这才是「单信号够不够」的直接证据）
const longSegs = segs.filter((s) => s.end - s.start + 1 >= 5)
const inAll = rows.filter((r) => longSegs.some((s) => r.t >= s.start && r.t <= s.end))
if (inAll.length) {
  const cov = (k) => ((inAll.filter((r) => r[k]).length / inAll.length) * 100).toFixed(1)
  console.log(`\n只看长度 >=5 秒的战斗段落（${longSegs.length} 段，${inAll.length} 帧）：`)
  console.log(`  连击可见 ${cov('comboOn')}%   屏障 ${cov('barrier')}%   掉血 ${cov('hurt')}%`)
  console.log(`  ⇒ 任一信号单独都不够；这就是「融合」的依据。`)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), fps: 1, rows, segs }, null, 0))
console.log(`\n时间轴已写入 ${OUT}`)

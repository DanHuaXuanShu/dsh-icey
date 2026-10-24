/**
 * probe/verify-combo.mjs —— 真机验证连招：一边发键一边连拍帧
 *
 * 为什么要它：连招的效果（挥刀、位移、凝滞定身）只有几百毫秒，
 * 单张截图抓不到过程。这里在发连招的同时以 ~100ms 间隔连拍，
 * 事后按「帧间差异」看出动作发生在第几帧，并把关键帧存下来人工确认。
 *
 * 用法：
 *   node probe/verify-combo.mjs "jjji|s+j"
 *   node probe/verify-combo.mjs "jo" 3          # 连拍 3 秒
 *
 * 输出：shots/combo-verify/<安全名>/fNN.png + 差异曲线
 */
import { NativeBackend } from '../lib/host.mjs'
import { encodePng, diffRatio } from '../lib/png.mjs'
import { planAction } from '../lib/control.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const keys = process.argv[2] || 'jjjjj'
const seconds = Number(process.argv[3]) || 2.5
const safe = keys.replace(/[^jilu89wsado_+|]/gi, '_').replace(/\|/g, 'P')
const dir = `shots/combo-verify/${safe}`
mkdirSync(dir, { recursive: true })

const plan = planAction({ action: 'combo', keys }, {})
console.log(`连招 "${keys}" → ${plan.desc}`)
for (const s of plan.steps) {
  if (s.withSteps) console.log(`  按住 ${s.key} ${s.holdMs}ms，期间点 ${s.withSteps.map((x) => x.key).join(',')}`)
  else console.log(`  点 ${s.key} ${s.holdMs}ms`)
}

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) {
  console.log('没找到 ICEY —— 先把游戏开起来（icey_start）')
  await nb.dispose()
  process.exit(1)
}

/* 抓一帧的工具（跟 play() 一样要挡黑帧：PrintWindow 偶发抓到全黑） */
const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
    if (lum > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 40))
  }
  return { ok: false, error: '连续 3 次抓到黑帧' }
}

/* ① 基准帧（发招之前，静止时） */
const base = await grab()
if (!base.ok) { console.log('抓帧失败'); await nb.dispose(); process.exit(1) }
writeFileSync(`${dir}/f00-base.png`, encodePng(base.width, base.height, base.data))
console.log(`基准帧 ${base.width}x${base.height}`)

/* ② 先抢前台（这一步可能上千毫秒，**不能算进按键耗时**），再开始计时发键 */
await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 150))
const t0 = Date.now()
const sendTask = (async () => {
  for (const step of plan.steps) {
    const d = await nb.keydown(step.key)
    if (!d.ok) { console.log(`按下 ${step.key} 失败: ${d.error}`); continue }
    try {
      if (Array.isArray(step.withSteps) && step.withSteps.length) {
        let used = 0
        for (const sub of step.withSteps) {
          const sd = await nb.keydown(sub.key)
          if (sd.ok) {
            await new Promise((r) => setTimeout(r, sub.holdMs))
            await nb.keyup(sub.key)
          }
          used += sub.holdMs
        }
        const rest = Math.max(0, step.holdMs - used)
        if (rest > 0) await new Promise((r) => setTimeout(r, rest))
      } else {
        await new Promise((r) => setTimeout(r, step.holdMs))
      }
    } finally {
      await nb.keyup(step.key)
    }
  }
  return Date.now() - t0
})()

/* ③ 连拍：每 ~100ms 一帧，直到时间到 */
const frames = []
let prev = { rgba: base.data, width: base.width, height: base.height }
let i = 0
while (Date.now() - t0 < seconds * 1000) {
  const c = await grab()
  if (!c.ok) { await new Promise((r) => setTimeout(r, 50)); continue }
  i++
  const d = diffRatio(prev.rgba, c.data)
  const at = Date.now() - t0
  prev = { rgba: c.data, width: c.width, height: c.height }
  frames.push({ i, at, d })
  writeFileSync(`${dir}/f${String(i).padStart(2, '0')}.png`, encodePng(c.width, c.height, c.data))
}

const sendMs = await sendTask

/* ④ 汇总 */
console.log(`\n按键总耗时 ${sendMs}ms，连拍 ${frames.length} 帧（每帧 ~100ms）`)
console.log('帧   时刻    与上一帧差异')
let peak = { d: 0 }
for (const fr of frames) {
  const bar = '█'.repeat(Math.min(40, Math.round(fr.d * 100)))
  console.log(`${String(fr.i).padStart(3)} ${String(fr.at).padStart(5)}ms  ${(fr.d * 100).toFixed(1).padStart(5)}%  ${bar}`)
  if (fr.d > peak.d) peak = fr
}
console.log(`\n最大变化在第 ${peak.i} 帧（${peak.at}ms，${(peak.d * 100).toFixed(1)}%）`)
const active = frames.filter((fr) => fr.d > 0.02).length
console.log(`有明显画面变化的帧：${active}/${frames.length}`)
console.log(`关键帧都在 ${dir}/`)

await nb.dispose()

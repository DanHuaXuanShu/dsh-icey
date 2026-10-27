/**
 * probe/meta-decide.mjs —— 在真录像帧上跑完整决策，看「元叙事控制台」这段插件会按什么。
 *
 * 背景：meta-audit 已经证明控制台**不会被判成暂停菜单**（menuRows=0），
 *   所以「插件按 Esc 退出控制台」这个说法已经被否掉了。
 *   那它到底会做什么？—— 这就是这个脚本要回答的：把同一批帧按真实节奏（每帧 2 秒）
 *   喂进 createPolicy().decide()，逐帧打印动作和理由。
 *
 * 为什么用 2 秒间隔：probe/meta-console2 的帧是 fps=1/2 抽的，正好一帧一步；
 *   而插件的决策循环实测是 0.89 秒/步 —— 2 秒比真机慢一倍，只会**少**触发节流类动作，
 *   不会凭空多出动作，所以对「会不会瞎撞」这个问题是偏保守的。
 *
 * 用法：
 *   node probe/meta-decide.mjs probe/meta-console2
 *   node probe/meta-decide.mjs probe/meta-console2 --from 8 --to 22   # 只看第 8~22 帧
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { fitWidth } from '../lib/png.mjs'
import { analyzeFrame, createPolicy } from '../lib/autoplay.mjs'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node probe/meta-decide.mjs <帧目录> [--from n] [--to n]')
  process.exit(2)
}
const argNum = (name, dflt) => {
  const i = process.argv.indexOf(name)
  if (i < 0) return dflt
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : dflt
}
const from = argNum('--from', 0)
const to = argNum('--to', Number.MAX_SAFE_INTEGER)

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.png') && !/contact|sheet|table/i.test(f))
  .sort()

const policy = createPolicy('advance', { moveDir: 'right' })
let prev = null
const STEP_MS = 2000

console.log(`\n=== ${dir} → decide() 逐帧 ===`)
console.log(`帧 ${files.length} 张，每帧间隔 ${STEP_MS}ms（模拟 1/2fps 抽帧）\n`)

for (let i = 0; i < files.length; i++) {
  const f = files[i]
  const img = decodePng(readFileSync(`${dir}/${f}`))
  const fitted = fitWidth(img.rgba, img.width, img.height, 480)
  const a = analyzeFrame(fitted.data, fitted.width, fitted.height, prev)
  if (!a.ok) { console.error('分析失败', f, a.reason); process.exit(3) }
  prev = { rgba: fitted.data, width: fitted.width, height: fitted.height, hud: a.hud }
  const now = i * STEP_MS
  const d = policy.decide(a, { now })
  if (i >= from && i <= to) {
    const t = `${i}s`.padStart(5)
    console.log(`${t} ${f}  ${String(d.action).padEnd(8)} ${String(d.ms ?? '').padStart(5)}ms  ${d.why ?? ''}`)
  }
}

// 动作直方图 —— 一眼看出有没有在「瞎撞」
const hist = new Map()
// 重跑一遍收集？没必要：上面已经打印了。这里只提示看哪。
console.log('\n（看 why 里的关键词：脱困阶梯 / 原地踏步 / 按确认键 / 听旁白）')

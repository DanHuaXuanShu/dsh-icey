/**
 * probe/ab-analyze.mjs —— analyzeFrame 的 A/B 基线
 *
 * 分层重构（把通用原语抽到 lib/ui/）会改 analyzeFrame 的内部实现。
 * 这个脚本保证**数值一个都不变**：对同一批真实帧跑一遍，把结果存 JSON；
 * 重构后再跑一遍，逐字段对比，不一致就报错。
 *
 * 用法：
 *   node probe/ab-analyze.mjs save     # 重构前：存基线
 *   node probe/ab-analyze.mjs check    # 重构后：对比
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'

const mode = process.argv[2] || 'check'
const OUT = 'probe/fixtures/analyze-baseline.json'
const DIR = 'shots/user-video'

// 取 120 张（覆盖全片各段），相邻帧配对算 motion
const files = readdirSync(DIR).filter((f) => /^f\d+\.png$/.test(f)).sort()
const step = Math.max(1, Math.floor(files.length / 120))
const picked = files.filter((_, i) => i % step === 0).slice(0, 120)

const rows = []
let prev = null
for (const f of picked) {
  const img = decodePng(readFileSync(`${DIR}/${f}`))
  const a = analyzeFrame(img.rgba, img.width, img.height, prev)
  rows.push({ f, ...a })
  prev = { rgba: img.rgba, width: img.width, height: img.height, hud: a.hud }
}

if (mode === 'save') {
  writeFileSync(OUT, JSON.stringify(rows), 'utf8')
  console.log(`基线已存：${OUT}（${rows.length} 帧）`)
  // 顺便报一下字段范围，方便判断基线是否覆盖到各种情况
  const stat = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number')
    if (!v.length) return '（无）'
    return `min ${Math.min(...v).toFixed(4)} / max ${Math.max(...v).toFixed(4)}`
  }
  for (const k of ['hud', 'hudBright', 'promptBright', 'subtitle', 'vfx', 'motion', 'hudKick']) {
    console.log(`  ${k.padEnd(14)} ${stat(k)}`)
  }
} else {
  const base = JSON.parse(readFileSync(OUT, 'utf8'))
  if (base.length !== rows.length) {
    console.log(`❌ 帧数不同：基线 ${base.length}，现在 ${rows.length}`)
    process.exit(1)
  }
  let bad = 0
  const keys = ['ok', 'width', 'height', 'hud', 'hudBright', 'promptBright', 'subtitle', 'vfx', 'motion', 'hudKick']
  for (let i = 0; i < base.length; i++) {
    for (const k of keys) {
      const A = base[i][k], B = rows[i][k]
      if (typeof A === 'number' && typeof B === 'number') {
        if (Math.abs(A - B) > 1e-9) {
          if (bad < 10) console.log(`  ❌ ${base[i].f} ${k}: ${A} → ${B}`)
          bad++
        }
      } else if (A !== B) {
        if (bad < 10) console.log(`  ❌ ${base[i].f} ${k}: ${A} → ${B}`)
        bad++
      }
    }
  }
  if (bad === 0) {
    console.log(`✅ 完全一致（${rows.length} 帧 × ${keys.length} 个字段）`)
  } else {
    console.log(`\n共 ${bad} 处不一致`)
    process.exit(1)
  }
}

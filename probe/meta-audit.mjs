/**
 * probe/meta-audit.mjs —— 审「元叙事控制台被当成暂停菜单」这条疑案（不开游戏）。
 *
 * 来由（HANDOFF 十二节，2026-10-27 18:24）：
 *   看完 25.5 分钟录像后发现，11–13 分那个**红棕色、左上角列着 scene 名**的界面
 *   是元叙事控制台（游戏故意打破第四面墙的那个菜单），不是暂停菜单。
 *   当时只写了「插件现在按菜单处理（Esc / 确认键）—— 这很可能就是『这处过不去』的一部分，待验证」，
 *   没有验证过。这个脚本就是来验的：把真录像抽出来的帧喂进 analyzeFrame，
 *   看 menuRows 到底是不是 >= MENU_RED_ROWS。
 *
 * 为什么用录像抽帧而不是实机：控制台只在特定剧情点出现，实机复现要重走一大段路；
 * 而录像里它连演了两分钟 —— 抽帧就够了。
 *
 * ⚠️ 帧是 1920x1080（录像），插件实时吃的是 1606x935 的窗口帧缩到 480 宽。
 *    menuRows 是**全图**红色文字行、不依赖归一化框，所以跨比例可比；
 *    但 hp/shield 这种用归一化框的读数在这里只能当参考，别拿它下结论。
 *
 * 用法：
 *   node probe/meta-audit.mjs probe/meta-console            # 全部帧，逐帧表
 *   node probe/meta-audit.mjs probe/meta-console --quiet    # 只报判成菜单的帧
 */
import { readdirSync, readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { fitWidth } from '../lib/png.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { classifyScene } from '../lib/games/icey/scene.mjs'
import { MENU_RED_ROWS } from '../lib/games/icey/layout.mjs'

const dir = process.argv[2]
const quiet = process.argv.includes('--quiet')
if (!dir) {
  console.error('usage: node probe/meta-audit.mjs <帧目录> [--quiet]')
  process.exit(2)
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.png') && !/contact|sheet|table/i.test(f))
  .sort()
if (!files.length) {
  console.error('目录里没有 png:', dir)
  process.exit(2)
}

const analysisWidth = 480
const rows = []
for (const f of files) {
  const img = decodePng(readFileSync(`${dir}/${f}`))
  const fitted = fitWidth(img.rgba, img.width, img.height, analysisWidth)
  const a = analyzeFrame(fitted.data, fitted.width, fitted.height, null)
  if (!a.ok) {
    console.error(`分析失败 ${f}: ${a.reason}`)
    process.exit(3)
  }
  const cls = classifyScene(a, { stuck: false })
  rows.push({
    f,
    menuRows: a.menuRows,
    scene: cls.scene,
    why: cls.why,
    hud: a.hud,
    hudBright: a.hudBright,
    subtitleRows: a.subtitleRows,
    combo: a.combo,
    hp: a.hp,
    shield: a.shield,
    src: `${img.width}x${img.height}`,
  })
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '-')

console.log(`\n=== ${dir} ===`)
console.log(`帧 ${rows.length} 张（原尺寸 ${rows[0].src} → 分析宽度 ${analysisWidth}），MENU_RED_ROWS = ${MENU_RED_ROWS}\n`)

const menuHits = rows.filter((r) => r.menuRows >= MENU_RED_ROWS)
console.log(`判成「菜单」的帧：${menuHits.length}/${rows.length}`)
for (const r of menuHits) console.log(`  🔴 ${r.f}  menuRows=${r.menuRows}  scene=${r.scene}`)
console.log()

if (!quiet) {
  console.log('文件    menuRows  scene     字幕行  hud亮     combo     hp       盾')
  for (const r of rows) {
    const flag = r.menuRows >= MENU_RED_ROWS ? ' 🔴' : '   '
    console.log(
      `${r.f}${flag} ${String(r.menuRows).padStart(6)}  ${r.scene.padEnd(8)} `
      + `${String(r.subtitleRows).padStart(5)}  ${pct(r.hudBright).padStart(7)} `
      + `${pct(r.combo).padStart(7)}  ${pct(r.hp).padStart(7)}  ${pct(r.shield).padStart(7)}`,
    )
  }
}

// 场景归类分布 —— 这一眼就能看出控制台被归成了哪一类
const dist = new Map()
for (const r of rows) dist.set(r.scene, (dist.get(r.scene) ?? 0) + 1)
console.log('\n--- 场景归类分布 ---')
for (const [k, v] of [...dist].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(9)} ${v}`)

// 一帧都不判菜单时，把 menuRows 的分布打出来 —— 「0」和「差一点」是两种不同的结论
if (!menuHits.length) {
  const vals = rows.map((r) => r.menuRows).sort((a, b) => a - b)
  console.log(`\n⚠️ 没有一帧被判成菜单。menuRows 分布：min ${vals[0]} / 中位 ${vals[Math.floor(vals.length / 2)]} / max ${vals[vals.length - 1]}`)
  console.log('   ⇒ 控制台不是「被红字判据吃掉了」，得从别处解释「这处过不去」。')
}

/**
 * probe/menu-audit.mjs —— 用**真实截图**审计「菜单判定」，不开游戏。
 *
 * 为什么需要它（2026-10-26 踩到的两个真 bug，都靠这个脚本量出来）：
 *   ① `findRedTextRows` 原来只在 1280×745 上标定，而插件实际分析宽度是 analysisWidth
 *      （默认 480）。真菜单的红色警告行缩到 480 只剩 3 行高，被 `minBandHeight=5` 滤掉
 *      ⇒ 默认配置下**暂停菜单根本认不出来**，插件也就不会按 Esc 退出它。
 *   ② 480 宽下战斗里的红色霓虹窗/伤害火花反而能过旧判据 ⇒ 593 张战斗帧里 28 帧被判成
 *      「在菜单」，决策层按了 22 次 Esc（战斗中按 Esc = 打开暂停菜单）。
 *
 * 修法是「按分辨率折算高度门槛 + 细笔画判据」（见 lib/ui/scan.mjs 的注释）。
 * 这个脚本用来回归：改阈值前后各跑一次，看这两组数字有没有变差。
 *
 * 用法：
 *   node probe/menu-audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { fitWidth } from '../lib/png.mjs'
import { findRedTextRows } from '../lib/ui/scan.mjs'
import { analyzeFrame, createPolicy } from '../lib/autoplay.mjs'

const MENU_FRAME = 'shots/menu-check/f_000.png'

function load(path, maxWidth) {
  const img = decodePng(readFileSync(path))
  if (!maxWidth) return { data: img.rgba, width: img.width, height: img.height }
  return fitWidth(img.rgba, img.width, img.height, maxWidth)
}

/* ---------------- ① 真菜单在各种分析宽度下都要认得出 ---------------- */
console.log('=== ① 真菜单（红色警告行）在各分析宽度下 ===')
console.log('（配置允许 analysisWidth 320~800；默认 480）')
for (const w of [320, 400, 480, 640, 800, 960, 1280]) {
  const f = load(MENU_FRAME, w)
  const bands = findRedTextRows(f.data, f.width, f.height)
  // 320/400 下文字被缩得连红色都不够，这是已知边界，不报错但要标出来
  const mark = bands.length ? '✓' : (f.width < 480 ? '✗（已知边界：分析宽度太低，红字被缩没了）' : '✗ 认不出')
  console.log(`  ${String(f.width).padStart(4)}x${String(f.height).padEnd(4)} → ${bands.length} 条 ${mark}`)
}

/* ---------------- ② 不该判成菜单的样本 ---------------- */
function scanDir(dir, label, pattern) {
  const files = readdirSync(dir).filter((f) => pattern.test(f) && !/contact|sheet/i.test(f)).sort()
  let menuFrames = 0
  let esc = 0
  const flagged = []
  const policy = createPolicy('advance')
  let prev = null
  for (const f of files) {
    const fit = load(`${dir}/${f}`, 480)
    const a = analyzeFrame(fit.data, fit.width, fit.height, prev)
    if (!a.ok) continue
    prev = { rgba: fit.data, width: fit.width, height: fit.height, hud: a.hud }
    if ((a.menuRows || 0) >= 1) {
      menuFrames++
      // hudBright 很低（HUD 被压暗）说明很可能真是菜单 —— 不是误判
      flagged.push(`${f}(hud ${(a.hudBright * 100).toFixed(1)}%)`)
    }
    if (policy.decide(a, { now: files.indexOf(f) * 690 }).action === 'pause') esc++
  }
  console.log(`  ${label.padEnd(22)} 帧 ${String(files.length).padStart(4)} | 判成菜单 ${String(menuFrames).padStart(3)} | 按 Esc ${esc}`)
  if (flagged.length) {
    console.log(`    留标的帧：${flagged.slice(0, 8).join(', ')}${flagged.length > 8 ? ' …' : ''}`)
    console.log('    （判据本身分不出「真菜单」和「误判」，这些帧要人工看一眼：'
      + 'shots/watch 里 w0013 就是真暂停菜单，所以低 hudBright 的留标大多是准的）')
  }
}

console.log('\n=== ② 非菜单样本（480 宽；战斗/空地应当全是 0）===')
scanDir('shots/combat', '战斗 combat', /\.png$/i)
scanDir('shots/combat3', '空地 combat3', /\.png$/i)
scanDir('shots/combat2', '空地 combat2', /^f_\d+\.png$/i)
scanDir('shots/watch', '探索 watch（含真菜单）', /\.png$/i)

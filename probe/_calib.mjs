// 满血满盾标定：抓一帧活的画面，把 HUD 各区域的读数打出来。
// 用法：node probe/_calib.mjs        （游戏要开着，不必在前台）
import { NativeBackend } from "../lib/host.mjs";
import { grabFrame } from "../lib/vision.mjs";
import { analyzeFrame } from "../lib/autoplay.mjs";
import { HP_BOX, SHIELD_BOX } from "../lib/games/icey/layout.mjs";

const nb = new NativeBackend();
await nb.start();
const f = await nb.find("ICEY.exe");
if (!f) { console.log("没找到 ICEY.exe"); await nb.dispose(); process.exit(1) }

const fr = await grabFrame(nb, f.hwnd, { maxWidth: 960, forAgent: true });
await nb.dispose();
if (!fr.ok) { console.log("抓帧失败：", fr.error); process.exit(1) }

const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(2) + "%")
console.log(`帧尺寸 ${fr.width}x${fr.height}\n`)

const m = analyzeFrame(fr.rgba, fr.width, fr.height)
console.log("=== 当前读数（满血满盾状态下）===")
console.log(`  hud     ${pct(m.hudBright)}   ← 左上 HUD 亮度占比（判断在不在游戏里）`)
console.log(`  hp      ${pct(m.hp)}   ← 血量条读数，满血应接近 HP_BASELINE_MAX`)
console.log(`  shield  ${pct(m.shield)}   ← 护盾读数`)
console.log(`  combo   ${pct(m.combo)}`)
console.log(`  bossBar ${m.bossBar}`)
console.log(`  promptBright ${pct(m.promptBright)}`)
console.log()

// ── 行扫描：把 HP_BOX / SHIELD_BOX 的每一行亮度摊开，看框是不是套多了或套少了 ──
// analyzeFrame 内部用什么宽度采样？这里按原帧宽扫，行号换成占整幅高的比例。
const W = fr.width, H = fr.height
function rowProfile(box, label, threshold = 0.15) {
  const x0 = Math.round(box.x0 * W), x1 = Math.round(box.x1 * W)
  const y0 = Math.round(box.y0 * H), y1 = Math.round(box.y1 * H)
  console.log(`=== ${label} 行扫描  x[${box.x0}~${box.x1}] y[${box.y0}~${box.y1}] → px x[${x0}~${x1}] y[${y0}~${y1}] ===`)
  const rows = []
  for (let y = y0; y < y1; y++) {
    let lit = 0, n = 0
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      const b = fr.rgba[i], g = fr.rgba[i + 1], r = fr.rgba[i + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      if (lum > 90) lit++
      n++
    }
    const ratio = n ? lit / n : 0
    rows.push({ y, yPct: y / H, ratio })
  }
  for (const r of rows) {
    const bar = "█".repeat(Math.min(40, Math.round(r.ratio * 40)))
    const mark = r.ratio >= threshold ? " ←" : ""
    console.log(`  y=${String(r.y).padStart(4)} (${(r.yPct * 100).toFixed(3)}%)  ${(r.ratio * 100).toFixed(1).padStart(5)}%  ${bar}${mark}`)
  }
  // 连续命中段的起止（真正有条的那几行）
  const hits = rows.filter((r) => r.ratio >= threshold)
  if (hits.length) {
    console.log(`  ⇒ 命中 ${hits.length} 行，从 y=${hits[0].y} (${(hits[0].yPct * 100).toFixed(3)}%) 到 y=${hits[hits.length - 1].y} (${(hits[hits.length - 1].yPct * 100).toFixed(3)}%)`)
  } else {
    console.log("  ⇒ 一行都没命中（框可能完全套空了）")
  }
  console.log()
}
rowProfile(HP_BOX, "HP_BOX")
rowProfile(SHIELD_BOX, "SHIELD_BOX")

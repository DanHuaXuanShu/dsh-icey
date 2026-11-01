/**
 * probe/tier-audit.mjs —— 拿**真实截图**审计 HUD 读数与战斗三档，不开游戏。
 *
 * 为什么需要这个：
 *   三档（healthy/cautious/danger）上线后实机跑了好几轮，日志里一次都没出现过低档位，
 *   但光看「血量和护盾都还够」这一句分不清三种原因：
 *     ① 真的没掉血
 *     ② hp/shield 检测被背景污染（读数一直接近满值）
 *     ③ hpBaseline 被早期异常高值锚死，ratio 永远接近 1
 *   实机跑一轮只能得到一个样本，而且要抢前台、要等。用存量截图可以一次跑几百帧，
 *   直接把「读数分布」和「基线最终值」摊开看。
 *
 * 用法：
 *   node probe/tier-audit.mjs shots/combat3
 *   node probe/tier-audit.mjs shots/combat
 *   node probe/tier-audit.mjs shots/combat2
 *
 * 只读文件，不碰游戏、不写任何东西。
 */
import { readdirSync, readFileSync } from "node:fs";
import { decodePng } from "../lib/png-decode.mjs";
import { fitWidth } from "../lib/png.mjs";
import { analyzeFrame, createPolicy, describeCombat } from "../lib/autoplay.mjs";
import { HP_BASELINE_MAX, SHIELD_BASELINE_MAX } from "../lib/games/icey/layout.mjs";

const dir = process.argv[2];
const analysisWidth = Number(process.argv[3]) || 480;
if (!dir) {
  console.error("usage: node probe/tier-audit.mjs <shots目录> [分析宽度=480]");
  process.exit(2);
}

// contact.png / 拼图不是帧，混进来会污染统计
const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".png") && !/contact|sheet/i.test(f))
  .sort();
if (!files.length) {
  console.error("目录里没有 png:", dir);
  process.exit(2);
}

// ⚠️ 含标题栏的旧帧目录（2026-10-31 之前 GetWindowRect 抓的，含白色标题栏）。
// layout.mjs 现在是「客户区坐标系」（capture() 已按 GetClientRect 裁掉标题栏），
// 拿旧帧套新框，血/盾框位整体偏上，读数不可信 —— 只配当历史参考，别拿它下结论。
const LEGACY_TITLEBAR_DIRS = /shots[/\\]combat($|[/\\])|shots[/\\]combat3($|[/\\])/i;
if (LEGACY_TITLEBAR_DIRS.test(dir.replace(/\\/g, '/'))) {
  console.log("\n⚠️ 这批帧是「含标题栏」的旧口径（GetWindowRect，含白色标题栏）。");
  console.log("   当前 layout 是「客户区坐标系」（capture 已裁标题栏），血/盾框位会整体偏上，");
  console.log("   下面所有血/盾读数仅作历史参考，不代表当前插件的真实表现。");
}

/** @type {Array<{f:string, hp:number, shield:number, combo:number, menuRows:number, motion:number|null}>} */
const rows = [];
const policy = createPolicy("advance", { moveDir: "right" });
let prev = null;
let dims = "";

for (const f of files) {
  let img
  try {
    img = decodePng(readFileSync(`${dir}/${f}`))
  } catch (e) {
    console.error(`跳过解不开的 ${f}: ${e.message}`)
    continue
  }
  // 插件实际喂进 analyzeFrame 的是 analysisWidth 宽的帧，这里保持一致，
  // 否则量出来的比例跟真机不是一回事（归一化框虽然抗缩放，但像素阈值不抗）。
  const fitted = fitWidth(img.rgba, img.width, img.height, analysisWidth)
  if (!dims) dims = `${img.width}x${img.height} → ${fitted.width}x${fitted.height}`
  // ⚠️ fitWidth 返回的是 { data, width, height }，不是 { rgba, ... }。
  // 写错字段时 analyzeFrame 会静默返回 {ok:false}，hp/shield 全 undefined ——
  // 看上去像「这游戏没有血条」，其实是脚本自己喂空了。所以这里必须炸出来。
  const a = analyzeFrame(fitted.data, fitted.width, fitted.height, prev)
  if (!a.ok) {
    console.error(`第 ${rows.length + 1} 帧分析失败：${a.reason}（${f}）`)
    process.exit(3)
  }
  prev = { rgba: fitted.data, width: fitted.width, height: fitted.height, hud: a.hud }
  rows.push({ f, hp: a.hp, shield: a.shield, combo: a.combo, menuRows: a.menuRows, motion: a.motion })
  // 真的跑一遍决策，遥测才有内容（档位判定就在 decide 里面）
  policy.decide(a, { now: rows.length * 300 })
}

const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "    -" : `${(v * 100).toFixed(2)}%`.padStart(7))

function stat(col) {
  const vals = rows.map((r) => r[col]).filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b)
  if (!vals.length) return null
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))]
  return { n: vals.length, min: vals[0], p10: q(0.1), p50: q(0.5), p90: q(0.9), max: vals[vals.length - 1] }
}

console.log(`\n=== ${dir} ===`)
console.log(`帧 ${rows.length} 张，尺寸 ${dims}`)
const hpS = stat("hp")
const shS = stat("shield")
const coS = stat("combo")
console.log("\n--- 原始读数（框内像素占比）---")
for (const [name, s] of [["hp(蓝=血)", hpS], ["shield(黄=盾)", shS], ["combo(战斗黄)", coS]]) {
  if (!s) { console.log(`${name}: 无数据`); continue }
  console.log(
    `${name.padEnd(14)} min ${pct(s.min)}  p10 ${pct(s.p10)}  p50 ${pct(s.p50)}  p90 ${pct(s.p90)}  max ${pct(s.max)}`,
  )
}

// 判读：满血/满盾的实测参考值（见 lib/games/icey/layout.mjs，2026-10-26 校准）。
// ⚠️ 这两个值是「客户区坐标系」口径标定的，只对**无标题栏的客户区帧**成立；
//    对含标题栏的旧帧（shots/combat、shots/combat3）不成立，框位会偏上。
const REF_HP_FULL = 0.6897
const REF_SHIELD_FULL = 0.1012
const menuFrames = rows.filter((r) => r.menuRows >= 1).length
console.log("\n--- 判读 ---")
if (hpS) {
  const over = rows.filter((r) => r.hp > REF_HP_FULL * 1.15).length
  console.log(`hp 中位 ${pct(hpS.p50)}，满血参考 ${pct(REF_HP_FULL)}；`
    + `高于参考值 15% 以上的帧 ${over}/${rows.length}`)
  if (over > rows.length * 0.2) {
    console.log("  ⚠️ 大量帧的 hp 读数明显高于「满血」—— 框内混进了别的蓝色（剑光/背景），基线会被锚高。")
  }
}
if (shS) {
  const over = rows.filter((r) => r.shield > REF_SHIELD_FULL * 1.5).length
  console.log(`shield 中位 ${pct(shS.p50)}，满盾参考 ${pct(REF_SHIELD_FULL)}；`
    + `高于参考值 50% 以上的帧 ${over}/${rows.length}`)
  if (over > rows.length * 0.2) {
    console.log("  ⚠️ shield 读数普遍偏高于「满盾」—— 黄色框可能吃到了别处的高饱和黄。")
  }
}
if (menuFrames) console.log(`有 ${menuFrames} 帧被判成菜单（红色文字行 ≥1），这些帧不会进战斗分支。`)

const cs = policy.combatStats
console.log("\n--- 战斗档位遥测 ---")
console.log(describeCombat(cs))
console.log(`\n基线最终值：血 ${pct(cs.hpBaseline)}  盾 ${pct(cs.shieldBaseline)}`)
// 基线是「见过最大值」，但要区分三种情况，别一刀切说「污染」：
//   ① > 上限（HP_BASELINE_MAX / SHIELD_BASELINE_MAX）→ 真被污染、被夹住上限
//   ② == 下限托底（HP_BASELINE_FLOOR=0.84）→ 整局没满过血、被下限托底（不是污染）
//   ③ 落在两者之间 → 正常
function judgeBaseline(name, baseline, max, floor) {
  if (baseline > max + 1e-9) return `${name}基线 ${pct(baseline)} > 上限 ${pct(max)} ⇒ 真被污染、被夹住上限`
  if (floor !== undefined && Math.abs(baseline - floor) < 1e-9) return `${name}基线 ${pct(baseline)} == 下限托底 ${pct(floor)} ⇒ 整局没满过、被下限托底（不是污染）`
  return `${name}基线 ${pct(baseline)} 落在正常区间（上限 ${pct(max)}）`
}
// HP_BASELINE_FLOOR 是 autoplay.mjs 里的模块内常量（0.84），这里不 import，直接说明它存在
console.log("  · " + judgeBaseline("血", cs.hpBaseline, HP_BASELINE_MAX, 0.84))
console.log("  · " + judgeBaseline("盾", cs.shieldBaseline, SHIELD_BASELINE_MAX, undefined))
if (cs.changes.length) {
  console.log("\n--- 换档明细 ---")
  for (const c of cs.changes) {
    console.log(`  t=${(c.at / 1000).toFixed(1)}s  ${c.from} → ${c.to}  `
      + `原始 血 ${pct(c.hp)} 盾 ${pct(c.shield)}  ratio 血 ${(c.hpRatio * 100).toFixed(0)}% 盾 ${(c.shieldRatio * 100).toFixed(0)}%`)
  }
}

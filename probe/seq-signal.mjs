/**
 * probe/seq-signal.mjs —— 对一段**等间隔连续帧**逐帧算信号，不做抽稀。
 *
 * 为什么要这个：原来的 battle-signal.mjs 用 sample() 从 593 张里抽 60 张，
 * 相邻样本实际间隔几秒，motion 反映的是采样间隔而不是画面内容 ——
 * 它因此让「战斗帧」和「旁观帧」看起来分不开（motion 66.8% vs 70.8%），
 * 而等间隔真实值差 20 倍。那个脚本 2026-10-25 已删，用它得出的结论全部作废。
 *
 * 用法：node probe/seq-signal.mjs shots/combat2 [标签]
 */
import { readdirSync, readFileSync } from "node:fs";
import { decodePng } from "../lib/png-decode.mjs";
import { analyzeFrame } from "../lib/autoplay.mjs";

const dir = process.argv[2];
const label = process.argv[3] || dir;
if (!dir) {
  console.error("usage: node probe/seq-signal.mjs <dir> [label]");
  process.exit(2);
}

const files = readdirSync(dir)
  .filter((f) => /^f_\d+\.png$/.test(f))
  .sort();
if (!files.length) {
  console.error("no f_*.png in", dir);
  process.exit(2);
}

const rows = [];
let prev = null;
for (const f of files) {
  const img = decodePng(readFileSync(`${dir}/${f}`));
  const a = analyzeFrame(img.rgba, img.width, img.height, prev);
  prev = { rgba: img.rgba, width: img.width, height: img.height, hud: a.hud };
  rows.push({
    f,
    motion: a.motion,
    vfx: a.vfx,
    hudKick: a.hudKick,
    hudBright: a.hudBright,
    subtitle: a.subtitle,
  });
}

const pct = (v) => (v === null || v === undefined ? "   -  " : (v * 100).toFixed(2).padStart(6));
console.log(`\n=== ${label}（${rows.length} 帧，等间隔）===`);
console.log("frame  motion   vfx  hudKick  hudBright  subtitle");
for (const r of rows) {
  console.log(
    `${r.f.slice(2, 5)}  ${pct(r.motion)} ${pct(r.vfx)} ${pct(r.hudKick)}  ${pct(r.hudBright)}     ${r.subtitle ? "Y" : ""}`,
  );
}

function q(col, f) {
  const vals = rows
    .map((r) => r[col])
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
}

console.log("\n--- 分位 ---");
for (const col of ["motion", "vfx", "hudKick", "hudBright"]) {
  const p10 = q(col, 0.1),
    p50 = q(col, 0.5),
    p90 = q(col, 0.9);
  const fmt = (v) => (v === null ? "  -  " : (v * 100).toFixed(2).padStart(6));
  console.log(`${col.padEnd(10)} p10 ${fmt(p10)}  p50 ${fmt(p50)}  p90 ${fmt(p90)}`);
}

const sub = rows.filter((r) => r.subtitle).length;
console.log(`\n有字幕的帧: ${sub}/${rows.length}`);

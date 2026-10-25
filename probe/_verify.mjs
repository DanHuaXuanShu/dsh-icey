// 用真实录制片段验证：combo 判战斗准不准。
// 用法：node probe/_verify.mjs <dir> [标签]
import { readdirSync, readFileSync } from "node:fs";
import { decodePng } from "../lib/png-decode.mjs";
import { analyzeFrame, createPolicy } from "../lib/autoplay.mjs";

const dir = process.argv[2];
const label = process.argv[3] || dir;
const files = readdirSync(dir).filter((f) => /^f_\d+\.png$/.test(f)).sort();

const p = createPolicy("advance");
let prev = null;
let fightN = 0;
const combos = [];
const motions = [];

for (let i = 0; i < files.length; i++) {
  const img = decodePng(readFileSync(`${dir}/${files[i]}`));
  const a = analyzeFrame(img.rgba, img.width, img.height, prev);
  prev = { rgba: img.rgba, width: img.width, height: img.height, hud: a.hud };
  const d = p.decide(
    { motion: a.motion, hudKick: a.hudKick, hudBright: a.hudBright, combo: a.combo, progress: 0.5, subtitle: a.subtitle },
    { now: i * 200 },
  );
  // 判战斗 = 出了战斗类动作（不含 chase/dash 这类也可能是位移的）
  if (["attack", "heavy", "combo", "storm", "shade"].includes(d.action)) fightN++;
  combos.push(a.combo ?? 0);
  motions.push(a.motion ?? 0);
}

const n = files.length;
const q = (arr, f) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * f))];
};
const pct = (v) => (v * 100).toFixed(2) + "%";

console.log(`\n=== ${label}（${n} 帧）===`);
console.log(`判成战斗: ${fightN}/${n} = ${((fightN / n) * 100).toFixed(0)}%`);
console.log(`combo    p10 ${pct(q(combos, 0.1))}  p50 ${pct(q(combos, 0.5))}  p90 ${pct(q(combos, 0.9))}`);
console.log(`motion   p10 ${pct(q(motions, 0.1))}  p50 ${pct(q(motions, 0.5))}  p90 ${pct(q(motions, 0.9))}`);

const hot = combos.map((c, i) => [i + 1, c]).filter(([, c]) => c >= 0.01);
console.log(
  `combo >= 1% 的帧: ${hot.slice(0, 24).map(([i, c]) => `${i}(${(c * 100).toFixed(1)}%)`).join(" ") || "（没有）"}` +
    (hot.length > 24 ? ` … 共 ${hot.length} 帧` : hot.length ? ` 共 ${hot.length} 帧` : ""),
);

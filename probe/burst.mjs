// 连拍：把一段游戏过程按固定间隔存成序列帧，用来标定「战斗中画面到底有什么稳定特征」。
// 用法：node probe/burst.mjs [张数] [间隔ms] [标签]
import { configure, session } from "../lib/session.mjs";
import fs from "node:fs";

const N = Number(process.argv[2] || 20);
const GAP = Number(process.argv[3] || 200);
const TAG = process.argv[4] || "burst";
const OUT = `D:/dsh/ICEY插件/shots/${TAG}`;

fs.mkdirSync(OUT, { recursive: true });
configure({ getConfig: () => ({}) });

const s = session();
const a = await s.attach();
if (!a.attached) {
  console.log("没接上:", a.reason);
  process.exit(0);
}

const t0 = Date.now();
const times = [];
for (let i = 0; i < N; i++) {
  const ts = Date.now();
  const f = await s.look({ maxWidth: 1280 });
  fs.writeFileSync(`${OUT}/f_${String(i).padStart(3, "0")}.png`, f.png);
  times.push(Date.now() - ts);
  console.log(
    `${String(i).padStart(3, "0")}  t=${String(Date.now() - t0).padStart(5)}ms  shot=${times[times.length - 1]}ms  ${f.width}x${f.height}  ${f.png.length}b`,
  );
  if (i < N - 1) await new Promise((r) => setTimeout(r, GAP));
}

const avg = times.reduce((x, y) => x + y, 0) / times.length;
console.log(
  `\n${N} 张，总耗时 ${Date.now() - t0}ms，单张均 ${avg.toFixed(0)}ms（间隙 ${GAP}ms）`,
);
console.log("目录:", OUT);
await s.dispose("probe-done");

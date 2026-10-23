import { GameSession } from "../lib/game.mjs";
import fs from "node:fs";
const gs = new GameSession({ getConfig: () => ({}) });
await gs.attach();
const save = async (name) => { const f = await gs.look({ maxWidth: 960 }); fs.writeFileSync(`D:/dsh/ICEY插件/shots/${name}.png`, f.png); return f.health.hash; };

console.log("t0:", await save("t0"));
// 按 Esc 看暂停菜单是否出现 —— 这是"按键真的进了游戏"的硬证据
const r1 = await gs.act({ action: "pause" }, {});
console.log("pause:", JSON.stringify(r1));
await new Promise(r => setTimeout(r, 700));
console.log("after esc:", await save("t1-esc"));
// 再按一次 Esc 关掉
await gs.act({ action: "pause" }, {});
await new Promise(r => setTimeout(r, 700));
console.log("after esc2:", await save("t2-esc2"));

// 长按右 2000ms
const r2 = await gs.act({ action: "move", dir: "right", ms: 2000 }, { withDiff: true });
console.log("move2s:", JSON.stringify({ok:r2.ok, changed:r2.changed, diff:r2.diff, steps:r2.steps}));
await new Promise(r => setTimeout(r, 500));
console.log("after move:", await save("t3-move"));
await gs.dispose();

import { GameSession } from "../lib/game.mjs";
const gs = new GameSession({ getConfig: () => ({}) });
await gs.attach();
const r = await gs.act({ action: "move", dir: "right", ms: 800 }, { withDiff: true });
console.log("act:", JSON.stringify({ok:r.ok, desc:r.desc, steps:r.steps, changed:r.changed, diff:r.diff, beforeHash:r.beforeHash, afterHash:r.afterHash, idleWaited:r.idleWaited, error:r.error}));
const look = await gs.look({ maxWidth: 960 });
(await import("node:fs")).writeFileSync("D:/dsh/ICEY插件/shots/after-move.png", look.png);
console.log("wrote after-move.png");
await gs.dispose();

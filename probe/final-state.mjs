import { configure, session } from "../lib/session.mjs";
import { encodePng } from "../lib/png.mjs";
import fs from "node:fs";
configure({ getConfig: () => ({}) });
const s = session();
const a = await s.attach();
if (!a.attached) { console.log("游戏没开"); process.exit(0) }
console.log("接上:", JSON.stringify({ hwnd: a.hwnd, pid: a.pid }));
// 松键兜底
const rel = await s.releaseAll();
console.log("松开的键:", JSON.stringify(rel));
const st = await s.status();
console.log("状态:", JSON.stringify({ running: st.running, playable: st.health?.playable, rect: st.rect, viewers: st.viewers }));
const f = await s.look({ maxWidth: 960 });
fs.writeFileSync("D:/dsh/ICEY插件/shots/final-state.png", f.png);
console.log("截图: shots/final-state.png", f.width + "x" + f.height, f.png.length + " bytes");
await s.dispose("probe-done");
console.log("已停止接管（游戏不关）");

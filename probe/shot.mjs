import { configure, session } from "../lib/session.mjs";
import fs from "node:fs";
configure({ getConfig: () => ({}) });
const s = session();
const a = await s.attach();
if (!a.attached) { console.log("没接上:", a.reason); process.exit(0) }
const f = await s.look({ maxWidth: 960 });
fs.writeFileSync("D:/dsh/ICEY插件/shots/panel-live.png", f.png);
console.log("截图:", f.width + "x" + f.height, f.png.length, "bytes");
await s.dispose("probe-done");

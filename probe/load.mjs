// 持续抓帧 25 秒（跟面板开着一样），同时测 DSH 的 HTTP 响应时间
import { configure, session } from "../lib/session.mjs";
configure({ getConfig: () => ({}) });
const s = session();
const a = await s.attach();
if (!a.attached) { console.log("游戏没开"); process.exit(0) }
console.log("开始 25 秒持续抓帧（模拟面板开着）");
const stop = Date.now() + 25000;
let frames = 0;
while (Date.now() < stop) {
  await s.captureStreamFrame(960);
  frames++;
}
const secs = 25;
console.log(`抓了 ${frames} 帧 / ${secs}s = ${(frames/secs).toFixed(1)} fps`);
await s.dispose("probe");

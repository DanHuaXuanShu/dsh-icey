import { NativeBackend } from "../lib/host.mjs";
import { grabFrame } from "../lib/vision.mjs";
import { encodePng } from "../lib/png.mjs";
import fs from "node:fs";
const nb = new NativeBackend();
await nb.start();
const find = () => nb.find("ICEY.exe");
const save = async (name) => {
  const f0 = await find();
  const fr = await grabFrame(nb, f0.hwnd, { maxWidth: 960, forAgent: true });
  if (!fr.ok) { console.log(name, "FAIL", fr.error); return null }
  fs.writeFileSync(`D:/dsh/ICEY插件/shots/${name}.png`, encodePng(fr.width, fr.height, fr.rgba));
  return fr.health.hash;
};
let f0 = await find();
if (!f0.foreground) { await nb.focus(f0.hwnd); }
console.log("fg:", (await find()).foreground);
// 用 Esc 判定当前在不在菜单：进菜单再退出，保证回到游戏
await nb.tap("Escape", 60); await new Promise(r => setTimeout(r, 700));
console.log("menu check:", await save("z0-menu"));
await nb.tap("Escape", 60); await new Promise(r => setTimeout(r, 900));
console.log("gameplay:", await save("z1-game"));
// 现在按住 d 1600ms，中途抓帧
await nb.keydown("d");
await new Promise(r => setTimeout(r, 500));  console.log("d+500:", await save("z2"));
await new Promise(r => setTimeout(r, 600));  console.log("d+1100:", await save("z3"));
await nb.keyup("d");
await new Promise(r => setTimeout(r, 400));  console.log("released:", await save("z4"));
await nb.dispose();

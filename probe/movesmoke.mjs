import { NativeBackend } from "../lib/host.mjs";
import { grabFrame } from "../lib/vision.mjs";
import fs from "node:fs";
const nb = new NativeBackend();
await nb.start();
const f = await nb.find("ICEY.exe");
console.log("fg:", f.foreground, "hwnd:", f.hwnd);
const save = async (name) => {
  const fr = await grabFrame(nb, f.hwnd, { maxWidth: 960, forAgent: true });
  if (!fr.ok) { console.log(name, "FAIL", fr.error); return null }
  fs.writeFileSync(`D:/dsh/ICEY插件/shots/${name}.png`, (await import("../lib/png.mjs")).encodePng(fr.width, fr.height, fr.rgba));
  return fr.health.hash;
};
// 先按一次 Esc 确保不在菜单里
await nb.tap("Escape", 60);
await new Promise(r => setTimeout(r, 800));
console.log("pre:", await save("m0"));
// 按住 d 不放，中途抓 3 帧
await nb.keydown("d");
await new Promise(r => setTimeout(r, 400)); console.log("d+400:", await save("m1"));
await new Promise(r => setTimeout(r, 500)); console.log("d+900:", await save("m2"));
await new Promise(r => setTimeout(r, 500)); console.log("d+1400:", await save("m3"));
await nb.keyup("d");
await new Promise(r => setTimeout(r, 300)); console.log("released:", await save("m4"));
// 再试 w (上)
await nb.keydown("w");
await new Promise(r => setTimeout(r, 900));
await nb.keyup("w");
await new Promise(r => setTimeout(r, 300)); console.log("after w:", await save("m5"));
await nb.dispose();

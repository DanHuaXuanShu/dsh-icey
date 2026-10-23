import { NativeBackend } from "../lib/host.mjs";
import { grabFrame } from "../lib/vision.mjs";
import { encodePng } from "../lib/png.mjs";
import fs from "node:fs";
const nb = new NativeBackend();
await nb.start();
const f = await nb.find("ICEY.exe");
const save = async (name) => {
  const fr = await grabFrame(nb, f.hwnd, { maxWidth: 960, forAgent: true });
  if (!fr.ok) { console.log(name, "FAIL", fr.error); return null }
  fs.writeFileSync(`D:/dsh/ICEY插件/shots/${name}.png`, encodePng(fr.width, fr.height, fr.rgba));
  return fr.health.hash;
};
await save("x0");
// 1) keydown d 后 OS 层面确认
await nb.keydown("d");
console.log("keystate d after keydown:", JSON.stringify(await nb.keystate("d")));
await new Promise(r => setTimeout(r, 300));
console.log("keystate d +300:", JSON.stringify(await nb.keystate("d")));
await nb.keyup("d");
console.log("keystate d after keyup:", JSON.stringify(await nb.keystate("d")));

// 2) 攻击键 j：看有没有挥剑动画
await nb.tap("j", 120);
await new Promise(r => setTimeout(r, 250));
console.log("after j:", await save("x1-attack"));
await new Promise(r => setTimeout(r, 600));
console.log("after j +850:", await save("x2-attack"));

// 3) 方向键 ArrowRight 按住 1s
await nb.keydown("ArrowRight");
await new Promise(r => setTimeout(r, 1000));
await nb.keyup("ArrowRight");
await new Promise(r => setTimeout(r, 300));
console.log("after ArrowRight:", await save("x3-arrowright"));
await nb.dispose();

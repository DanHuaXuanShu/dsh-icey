import { NativeBackend } from "../lib/host.mjs";
import { grabFrame } from "../lib/vision.mjs";
import { encodePng } from "../lib/png.mjs";
import fs from "node:fs";
const nb = new NativeBackend();
await nb.start();
const save = async (name) => {
  const f0 = await nb.find("ICEY.exe");
  const fr = await grabFrame(nb, f0.hwnd, { maxWidth: 960, forAgent: true });
  if (!fr.ok) { console.log(name, "FAIL", fr.error); return null }
  fs.writeFileSync(`D:/dsh/ICEY插件/shots/${name}.png`, encodePng(fr.width, fr.height, fr.rgba));
  return fr.health.hash;
};
const fgNow = async () => { const r = await nb.find("ICEY.exe"); return r.foreground; };

console.log("fg at start:", await fgNow());
// 控制组：Esc 应该还能开暂停菜单
const focusRes = await nb.focus((await nb.find("ICEY.exe")).hwnd);
console.log("focus:", JSON.stringify(focusRes));
console.log("fg after focus:", await fgNow());
await nb.tap("Escape", 60);
await new Promise(r => setTimeout(r, 800));
console.log("esc control:", await save("y0-esc"));
console.log("fg during:", await fgNow());
await nb.tap("Escape", 60);
await new Promise(r => setTimeout(r, 900));
console.log("esc2 close:", await save("y1-closed"));
console.log("fg:", await fgNow());
// 现在按住 d，并且在按住期间查前台
await nb.keydown("d");
for (let i = 0; i < 4; i++) {
  await new Promise(r => setTimeout(r, 350));
  console.log(`hold d +${(i+1)*350}: fg=${await fgNow()} hash=${await save("y2-hold" + i)}`);
}
await nb.keyup("d");
await nb.dispose();

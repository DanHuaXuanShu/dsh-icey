import { NativeBackend } from "../lib/host.mjs";
import { ensureForeground, restoreForeground } from "../lib/vision.mjs";
const nb = new NativeBackend();
await nb.start();
const icey = (await nb.find("ICEY.exe")).hwnd;
const fg = async () => (await nb.getForeground()).hwnd;

const before = await fg();
const r = await ensureForeground(nb, icey, { allowFocus: true });
console.log("ensureForeground:", JSON.stringify(r));
console.log("抢完之后前台:", await fg());
const back = await restoreForeground(nb, r.previousHwnd);
console.log("restoreForeground:", JSON.stringify(back));
console.log("还完之后前台:", await fg(), "(动作前是", before, ")");
await nb.dispose();

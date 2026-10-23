import { NativeBackend } from "../lib/host.mjs";
const nb = new NativeBackend();
await nb.start();
const dsh = 263534;
const icey = (await nb.find("ICEY.exe")).hwnd;
const fg = async () => (await nb.getForeground()).hwnd;
console.log("起点前台:", await fg(), " (ICEY =", icey, ", DSH =", dsh, ")");
// 主动把前台切到 DSH
const r = await nb.focus(dsh);
console.log("focus(DSH) 结果:", JSON.stringify({ requested: r.requested, isTarget: r.isTarget, attached: r.attached }));
console.log("立刻:", await fg());
for (const ms of [200, 500, 1000, 2000]) {
  await new Promise(r2 => setTimeout(r2, ms));
  const h = await fg();
  console.log(`+${ms}ms 后台: ${h} ${h === dsh ? "(DSH ✅)" : h === icey ? "(ICEY 抢回去了 ❌)" : "(别的窗口)"}`);
}
await nb.dispose();

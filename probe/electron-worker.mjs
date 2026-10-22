// 在 DSH 自己的 Electron 运行时里加载 worker + koffi，看会不会炸 / 能不能抓帧
import { Worker } from "node:worker_threads";
console.log("runtime:", JSON.stringify({ node: process.versions.node, electron: process.versions.electron || null, modules: process.versions.modules }));
const w = new Worker(new URL("../lib/win-backend.mjs", import.meta.url), { workerData: {} });
const done = new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 20000);
  w.on("message", (m) => {
    if (m.ready) { clearTimeout(t); resolve({ ready: m }) }
  });
  w.on("error", (e) => { clearTimeout(t); resolve({ error: String(e && e.message) }) });
  w.on("exit", (c) => { clearTimeout(t); resolve({ exit: c }) });
});
const r = await done;
console.log("worker:", JSON.stringify(r));
if (r.ready) {
  // 试一次 find + capture
  const call = (cmd, ms = 10000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    const h = (m) => { if (m.id === cmd.id) { clearTimeout(t); w.off("message", h); resolve(m) } };
    w.on("message", h);
    w.postMessage({ ...cmd, id: cmd.id });
  });
  const f = await call({ id: 1, cmd: "find", exe: "notepad.exe" });
  console.log("find notepad:", JSON.stringify({ ok: f.ok, found: f.found, error: f.error }));
  await w.terminate();
  console.log("terminated cleanly");
}
process.exit(0);

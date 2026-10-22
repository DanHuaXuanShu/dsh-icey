import { configure } from "../lib/session.mjs";
import { configPath, loadOverrides, saveOverrides } from "../lib/store.mjs";
const routes = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn(); return () => d?.() },
  connection: { fetch: { register(r) { routes.set(r.methods.join("+") + " " + r.path, r); return () => {} } } },
};
configure({ getConfig: () => ({}) });
const host = await import("../index.js");
host.apply(ctx, {});
const route = routes.get("GET+PATCH /api/dsh-icey/config");
const get = async () => (await route.fetch(new Request("http://x/api/dsh-icey/config"))).json();
const patch = async (body) => (await route.fetch(new Request("http://x/api/dsh-icey/config", { method: "PATCH", body: JSON.stringify(body) }))).json();

const before = await get();
console.log("路径:", before.storage.path);
console.log("改之前 fps/streamWidth:", before.config.fps, before.config.streamWidth);
const saved = await patch({ fps: 6, streamWidth: 800, restoreFocus: false });
console.log("保存:", JSON.stringify({ ok: saved.ok, savedTo: saved.savedTo, changed: saved.changed }));
console.log("改之后:", (await get()).config.fps, (await get()).config.streamWidth, "restoreFocus =", (await get()).config.restoreFocus);
console.log("文件内容:", JSON.stringify(loadOverrides()));
// 恢复默认，别把测试值留在用户机器上
const restore = await patch({ fps: 10, streamWidth: 960, restoreFocus: true });
console.log("恢复:", restore.ok, "->", JSON.stringify(loadOverrides()));

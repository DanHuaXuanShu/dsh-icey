import { configure, session } from "../lib/session.mjs";
configure({ getConfig: () => ({}) });
const s = session();
const a = await s.attach();
if (!a.attached) { console.log("游戏没开"); process.exit(0) }
const fg = async () => { const r = await s.backend.getForeground(); return { hwnd: r.hwnd, title: (r.title || "").slice(0, 30) } };
const before = await fg();
console.log("动作前:", JSON.stringify(before));
// withDiff:true 会等队列跑完
const res = await s.act({ action: "move", dir: "right", ms: 300 }, { withDiff: true });
console.log("act:", JSON.stringify({ ok: res.ok, changed: res.changed, diff: res.diff }));
const after = await fg();
console.log("动作后:", JSON.stringify(after));
console.log(before.hwnd && after.hwnd === before.hwnd ? "✅ 焦点还回去了" : "❌ 焦点没还");
await s.dispose("probe");

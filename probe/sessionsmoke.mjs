import { session, configure } from "../lib/session.mjs";
configure({ getConfig: () => ({}) });
const s = session();
const st = await s.status();
console.log("status:", JSON.stringify({running: st.running, playable: st.health?.playable, reason: st.health?.reason, backend: st.backend}, null, 1));
const a = await s.attach();
console.log("attach:", JSON.stringify({attached: a.attached, hwnd: a.hwnd, pid: a.pid}));
const st2 = await s.status();
console.log("status2:", JSON.stringify({running: st2.running, playable: st2.health?.playable, queue: st2.queue, rect: st2.rect}));
await s.dispose("probe");
console.log("disposed ok");


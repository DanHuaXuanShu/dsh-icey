import { NativeBackend } from "../lib/host.mjs";
const nb = new NativeBackend();
const r = await nb.start();
console.log("start:", JSON.stringify(r));
const f = await nb.find("ICEY.exe");
console.log("find:", JSON.stringify({found:f.found, hwnd:f.hwnd, rect:f.rect, fg:f.foreground, err:f.error}));
const cap = await nb.capture(f.hwnd, "printwindow");
console.log("capture:", JSON.stringify({ok:cap.ok, w:cap.width, h:cap.height, ms:cap.ms, bytes:cap.data?.length}));
const fo = await nb.focus(f.hwnd);
console.log("focus:", JSON.stringify(fo));
const ks = await nb.keystate("Escape");
console.log("keystate:", JSON.stringify(ks));
await nb.dispose();
console.log("disposed ok");


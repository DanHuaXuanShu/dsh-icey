/**
 * probe/focus-trace.mjs —— 追踪「点击之后前台跑到哪去了」
 *
 * 怀疑：SendInput 的鼠标绝对坐标归一化如果和实际屏幕分辨率/DPI 不一致，
 * 点击会落到别的窗口（比如 DSH），反而把 ICEY 的前台抢走 → 键盘从此失效。
 */
import { NativeBackend } from '../lib/host.mjs'

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
const fg = async () => { const r = await nb.getForeground(); return { hwnd: r.hwnd, title: (r.title || '').slice(0, 30), isIcey: r.hwnd === f.hwnd } }

console.log('窗口矩形:', JSON.stringify(f.rect))
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 300))
console.log('focus 后:      ', JSON.stringify(await fg()))

const c = await nb.click(f.hwnd, 20, 20)
console.log('click 返回:    ', JSON.stringify(c))
await new Promise((r) => setTimeout(r, 300))
console.log('click 后:      ', JSON.stringify(await fg()))

// 再抢一次前台，然后只看不点
await nb.focus(f.hwnd)
await new Promise((r) => setTimeout(r, 300))
console.log('重新 focus 后: ', JSON.stringify(await fg()))

// 键盘按 d 期间再看
await nb.keydown('d')
await new Promise((r) => setTimeout(r, 500))
console.log('按住 d 期间:   ', JSON.stringify(await fg()))
await nb.keyup('d')

await nb.dispose()

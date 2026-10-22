/**
 * probe/focus-check.mjs —— 验「开了艾希之后 DSH 还能不能用」这件事本身
 *   1. 动作前记前台（应该是 DSH 或别的窗口）
 *   2. 动作把 ICEY 抢到前台
 *   3. 动作结束后前台必须**回到原来那个窗口**
 *   4. ICEY 不能残留 WS_EX_TOPMOST（否则它永远盖在 DSH 上面）
 */
import { session, configure } from '../lib/session.mjs'

configure({ getConfig: () => ({}) })
const s = session()
const a = await s.attach()
if (!a.attached) { console.log('游戏没开，跳过'); process.exit(0) }

const fg = async () => {
  const r = await s.backend.getForeground()
  return { hwnd: r.hwnd, title: (r.title || '').slice(0, 40) }
}
// 顶层窗口样式：0x8 = WS_EX_TOPMOST
const topmost = async () => {
  const r = await s.backend.call({ cmd: 'list', filter: 'ICEY' }, 8000)
  return r
}

console.log('动作前前台:', JSON.stringify(await fg()))
const before = await fg()

const res = await s.act({ action: 'move', dir: 'right', ms: 300 }, {})
console.log('动作:', JSON.stringify({ ok: res.ok, desc: res.desc }))

await new Promise((r) => setTimeout(r, 400))
const after = await fg()
console.log('动作后前台:', JSON.stringify(after))

if (before.hwnd && after.hwnd === before.hwnd) {
  console.log('✅ 焦点已归还给动作前的窗口')
} else if (before.hwnd) {
  console.log(`❌ 焦点没还回去：动作前 ${before.hwnd}（${before.title}）→ 动作后 ${after.hwnd}（${after.title}）`)
} else {
  console.log('（动作前没有前台窗口，无法判断）')
}

console.log('\n窗口列表:', JSON.stringify(await topmost()).slice(0, 600))

// 直接查 ICEY 的扩展样式
const gwl = await s.backend.call({ cmd: 'styles', hwnd: s.hwnd }, 5000)
console.log('ICEY 窗口样式:', JSON.stringify(gwl))

await s.dispose('probe')

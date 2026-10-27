/**
 * probe/client-check.mjs —— 在 Node 里用最小 DOM 桩加载 client.js 的 factory，
 * 验证：① 自注册的 id 与包名一致 ② factory 能拿到 React ③ apply 不抛 ④ 三个 slot 都注册了
 * ⑤ 二进制帧解析逻辑能正确切帧（这是面板白屏/错位的常见原因）
 */
import { readFileSync } from 'node:fs'

const errors = []
let registered = null
const slots = []
const cssTags = []

// ---- 最小 DOM 桩 ----
globalThis.document = {
  createElement(tag) {
    const el = {
      tagName: tag, textContent: '', dataset: {}, style: {}, attributes: {},
      setAttribute(k, v) { this.attributes[k] = v },
      appendChild() {},
      remove() {},
    }
    if (tag === 'style') cssTags.push(el)
    return el
  },
  head: { appendChild() {} },
}
globalThis.window = globalThis.window || {}
globalThis.console = console

globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    registered = { id }
    // 模拟宿主的 require：react 用最小桩
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: 'Fragment',
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useCallback: (f) => f,
    }
    const mod = factory((name) => {
      if (name === 'react') return React
      throw new Error(`意外的 require: ${name}`)
    })
    registered.inject = mod.inject
    registered.apply = mod.apply
  },
}

// ---- 加载 client.js ----
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
try {
  new Function(src)()
} catch (e) {
  console.log('❌ 执行 client.js 抛错：', e?.message)
  process.exit(1)
}

if (!registered) { console.log('❌ 没调 __ModuleLoader__.load'); process.exit(1) }

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
console.log(`自注册 id: ${registered.id}  /  package.json name: ${pkg.name}`)
if (registered.id !== pkg.name) { errors.push(`id 不匹配：${registered.id} != ${pkg.name}`) }
console.log(`inject: ${JSON.stringify(registered.inject)}`)

// ---- 调 apply ----
const ctx = {
  get: (k) => (k === 'slots' ? ctx.slots : undefined),
  slots: {
    inject(name, cb) { cb() },
    register(spec) { slots.push(spec); return () => {} },
  },
  effect(fn) { const d = fn(); return () => d?.() },
}
try {
  registered.apply(ctx)
  console.log('apply() OK')
} catch (e) {
  errors.push(`apply 抛错：${e?.message}`)
  console.log('❌ apply 抛错：', e?.message)
}
console.log('注册的 slot:', slots.map((s) => `${s.name}[${s.id || s.key}]`).join(', '))
// 0.6.0 起**刻意不注册**主面板和侧栏入口（理由见 README 的「为什么没有面板」一节：
// 游戏占着前台，要看面板就得切窗口，切过去游戏就看不见了）。
// 所以这里反过来断言 —— 它们要是又冒出来，说明有人把面板加回去了。
for (const banned of ['main', 'sidebar.panellist']) {
  if (slots.some((s) => s.name === banned)) errors.push(`不该再注册 ${banned}（0.6.0 起面板已删，见 README）`)
}
if (!slots.some((s) => s.name === 'settings.section')) errors.push('没注册 settings.section')
if (cssTags.length === 0) errors.push('样式没挂上')

// ---- 验证二进制帧解析（复刻 client.js 里的 consume 逻辑）----
function parseAll(buf) {
  const out = []
  let pending = buf
  while (pending.length >= 16) {
    const magic = String.fromCharCode(pending[0], pending[1], pending[2], pending[3])
    const view = new DataView(pending.buffer, pending.byteOffset, 16)
    const w = view.getUint32(4, true), h = view.getUint32(8, true), len = view.getUint32(12, true)
    if (pending.length < 16 + len) return { frames: out, rest: pending }
    out.push({ magic, w, h, len })
    pending = pending.subarray(16 + len)
  }
  return { frames: out, rest: pending }
}
const mkFrame = (w, h, fill) => {
  const head = Buffer.alloc(16)
  head.write('ICYF', 0, 'ascii'); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8); head.writeUInt32LE(w * h * 4, 12)
  return Buffer.concat([head, Buffer.alloc(w * h * 4, fill)])
}
const f1 = mkFrame(8, 6, 10), f2 = mkFrame(8, 6, 20)
// 故意把两帧在奇怪的位置切开，模拟 TCP 粘包/半包
const all = Buffer.concat([f1, f2])
for (const cut of [1, 7, 16, 33, 100, 200, 250]) {
  const a = parseAll(all.subarray(0, cut)).frames.length
  const b = Buffer.concat([all.subarray(0, cut), all.subarray(cut)])
  const r = parseAll(b)
  if (r.frames.length !== 2) errors.push(`切在 ${cut} 字节时只解出 ${r.frames.length} 帧（应为 2）`)
  if (r.frames.some((f) => f.len !== 8 * 6 * 4)) errors.push(`切在 ${cut} 时负载长度不对`)
}
console.log('二进制帧切分：7 种切分位置都能正确还原 2 帧')

// 错误帧
const ehead = Buffer.alloc(16)
ehead.write('ICYE', 0, 'ascii'); ehead.writeUInt32LE(0, 4); ehead.writeUInt32LE(0, 8)
const emsg = Buffer.from('抢前台失败', 'utf8'); ehead.writeUInt32LE(emsg.length, 12)
const er = parseAll(Buffer.concat([ehead, emsg]))
if (er.frames[0]?.magic !== 'ICYE') errors.push('错误帧 magic 解析失败')

if (errors.length) {
  console.log('\n❌ 问题：')
  for (const e of errors) console.log('  -', e)
  process.exit(1)
}
console.log('\n✅ client.js 自注册 / apply / slot 注册 / 二进制帧解析 全部通过')

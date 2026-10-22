/**
 * probe/tool-check.mjs —— 真调 agent.js 注册出来的 6 个工具（桩 ctx，但抓帧/按键全是真的）
 * 这是「工具能不能用」最直接的验证：如果这里有输出 + 有图，宿主里就能用。
 */
import { configure } from '../lib/session.mjs'

const saved = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn(); return () => d?.() },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  attachments: {
    imageLimits: { maxWidth: 1568, maxHeight: 1568 },
    async saveImages(inputs) {
      return inputs.map((inp, i) => {
        saved.push({ name: inp.name, bytes: inp.data?.length, mediaType: inp.mediaType })
        return { id: `att-${saved.length}`, mediaType: inp.mediaType, width: 960, height: 559 }
      })
    },
  },
}
const tools = new Map()

configure({ getConfig: () => ({}) })
const agent = await import('../agent.js')
agent.apply(ctx)

const call = async (name, args = {}) => {
  const def = tools.get(name)
  if (!def) throw new Error(`没注册 ${name}`)
  const t0 = Date.now()
  const out = await def.execute(args, {})
  return { ms: Date.now() - t0, out }
}

const show = (label, r) => {
  const text = typeof r.out === 'string' ? r.out : r.out?.text
  const img = r.out?.image
  console.log(`\n=== ${label} (${r.ms}ms) ===`)
  console.log(String(text || '').slice(0, 700))
  if (img) console.log(`[图片] ${JSON.stringify(img)}`)
}

try {
  show('icey_status', await call('icey_status'))
  show('icey_start', await call('icey_start'))
  show('icey_look', await call('icey_look'))
  show('icey_act move right 800ms', await call('icey_act', { action: 'move', dir: 'right', ms: 800 }))
  show('icey_screenshot', await call('icey_screenshot'))
  show('icey_stop', await call('icey_stop'))
  console.log('\n图片调用记录:', JSON.stringify(saved, null, 1))
} catch (e) {
  console.log('❌', e?.message)
  console.log(String(e?.stack || '').split('\n').slice(0, 10).join('\n'))
  process.exitCode = 1
}
process.exit()

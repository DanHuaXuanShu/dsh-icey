/**
 * probe/stream-route-check.mjs —— 直接跑 index.js 注册的 /stream 路由（真抓帧、真协议）
 *
 * 量的是**宿主主线程**的代价：读 20 帧、解协议、统计字节与耗时。
 * 这正是「插件一开艾希，DSH 就卡死」的那个位置，必须给出数字。
 */
import { configure } from '../lib/session.mjs'

const routes = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn(); return () => d?.() },
  connection: {
    fetch: {
      register(route) {
        routes.set(`${route.methods.join('+')} ${route.path}`, route)
        return () => {}
      },
    },
  },
}

configure({ getConfig: () => ({}) })
const host = await import('../index.js')
host.apply(ctx, {})
console.log('路由:', [...routes.keys()].join('\n      '))

// 先 attach
const attachRoute = routes.get('POST /api/dsh-icey/attach')
const attachRes = await attachRoute.fetch(new Request('http://x/api/dsh-icey/attach', { method: 'POST', body: '{}' }))
const attachJson = await attachRes.json()
console.log('\nattach:', JSON.stringify(attachJson).slice(0, 200))
if (!attachJson.ok && !attachJson.attached) {
  console.log('游戏没开，跳过流测试')
  process.exit(0)
}

// 跑流
const streamRoute = routes.get('GET /api/dsh-icey/stream')
const req = new Request('http://x/api/dsh-icey/stream?fps=10&w=960')
const res = await streamRoute.fetch(req)
console.log('响应头:', JSON.stringify(Object.fromEntries(res.headers.entries())))

const reader = res.body.getReader()
let pending = new Uint8Array(0)
let frames = 0, bytes = 0, errors = 0
let firstW = 0, firstH = 0
const t0 = Date.now()
const N = 20
while (frames < N) {
  const { done, value } = await reader.read()
  if (done) break
  const merged = new Uint8Array(pending.length + value.length)
  merged.set(pending, 0); merged.set(value, pending.length)
  pending = merged
  while (pending.length >= 16) {
    const magic = String.fromCharCode(pending[0], pending[1], pending[2], pending[3])
    const view = new DataView(pending.buffer, pending.byteOffset, 16)
    const w = view.getUint32(4, true), h = view.getUint32(8, true), len = view.getUint32(12, true)
    if (pending.length < 16 + len) break
    const body = pending.subarray(16, 16 + len)
    if (magic === 'ICYF') {
      if (len !== w * h * 4) throw new Error(`负载长度不对: ${w}x${h} 期望 ${w * h * 4} 实际 ${len}`)
      if (!frames) { firstW = w; firstH = h }
      frames++
      bytes += 16 + len
    } else if (magic === 'ICYE') {
      errors++
      console.log('错误帧:', new TextDecoder().decode(body))
    }
    pending = pending.subarray(16 + len)
  }
}
const elapsed = Date.now() - t0
console.log(`\n读了 ${frames} 帧（${firstW}x${firstH}），共 ${(bytes / 1e6).toFixed(1)} MB，用时 ${elapsed}ms`)
console.log(`帧率 ${(frames / (elapsed / 1000)).toFixed(1)} fps，平均每帧 ${(elapsed / frames).toFixed(0)}ms`)
console.log(`单帧大小 ${(bytes / frames / 1e3).toFixed(0)} KB（原始分辨率是 6006 KB，base64 后 8008 KB）`)
console.log(`错误帧 ${errors} 个`)

// 关键对比：base64 那条路要多少
const perFrame = bytes / frames
console.log(`\n=== 对比 ===`)
console.log(`本方案每帧上行 ${(perFrame / 1e6).toFixed(2)} MB；base64 方案同一帧会是 ${(perFrame * 4 / 3 / 1e6).toFixed(2)} MB 字符串`)
console.log(`浏览器侧：本方案 0 次 atob + 0 次逐字节循环；旧方案 41ms/帧主线程`)

await reader.cancel().catch(() => {})
process.exit(0)

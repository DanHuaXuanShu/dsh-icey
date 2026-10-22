/**
 * probe/launch-check.mjs —— 走真实路由验证「点一下就能开游戏」
 *   ① 游戏没开时 /attach 必须**立刻**返回（不能静默等 60 秒）
 *   ② /launch mode=direct 必须真的把游戏拉起来并接上
 *   ③ 开起来之后 /status 必须是 running
 */
import { configure } from '../lib/session.mjs'

const routes = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn(); return () => d?.() },
  connection: { fetch: { register(r) { routes.set(`${r.methods.join('+')} ${r.path}`, r); return () => {} } } },
}
configure({ getConfig: () => ({}) })
const { spawn } = await import('node:child_process')
const host = await import('../index.js')
host.apply(ctx, {})

const hit = async (key, body) => {
  const r = routes.get(key)
  const t0 = Date.now()
  const res = await r.fetch(new Request(`http://x${r.path}`, {
    method: key.split(' ')[0],
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { ms: Date.now() - t0, json: await res.json() }
}

// ① attach（游戏没开）
const at = await hit('POST /api/dsh-icey/attach')
console.log(`① /attach  ${at.ms}ms  attached=${at.json.attached}  reason=${at.json.reason || ''}`)
if (at.ms > 5000) throw new Error(`attach 花了 ${at.ms}ms —— 又变成静默等待了`)

// ② launch attach 模式（游戏没开）：必须立刻失败并给出提示，而不是等 60 秒
const la = await hit('POST /api/dsh-icey/launch', {})
console.log(`② /launch(默认 attach)  ${la.ms}ms  ok=${la.json.ok}  error=${la.json.error || ''}`)
if (la.ms > 5000) throw new Error(`launch(attach) 花了 ${la.ms}ms —— 不该等窗口`)
if (la.json.ok !== false) throw new Error('游戏没开却报成功')

// ③ launch direct：真启动
console.log('③ /launch(mode=direct) …（Unity 加载中，最多等 60 秒）')
const ld = await hit('POST /api/dsh-icey/launch', { mode: 'direct', waitMs: 60000 })
console.log(`   ${ld.ms}ms  ok=${ld.json.ok}  hwnd=${ld.json.hwnd}  pid=${ld.json.pid}  rect=${JSON.stringify(ld.json.rect)}`)
if (!ld.json.ok) {
  console.log('   失败原因:', ld.json.error)
  console.log('   提示:', ld.json.hint)
  process.exitCode = 1
} else {
  const st = await hit('GET /api/dsh-icey/status')
  console.log(`④ /status  running=${st.json.running}  playable=${st.json.canAct}  窗口=${st.json.rect?.width}x${st.json.rect?.height}`)
  if (!st.json.running) process.exitCode = 1
}
process.exit()

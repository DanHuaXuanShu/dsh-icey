/**
 * probe/autoplay-check.mjs —— 真机验证「自主连玩」
 *
 * 不需要 DSH：直接起一个 GameSession，接上已经开着的 ICEY，跑一小段连玩，
 * 把「做了什么、画面怎么变」打出来，并存一张结束帧。
 *
 * 用法：
 *   node probe/autoplay-check.mjs [秒数] [preset]
 *   例：node probe/autoplay-check.mjs 20 advance
 */
import { configure, session } from '../lib/session.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 20
const preset = process.argv[3] || 'advance'

configure({ getConfig: () => ({}) })
const s = session()

const a = await s.attach()
if (!a.attached) { console.log('没接上游戏：', a.reason); process.exit(1) }
console.log(`接上: hwnd=${a.hwnd} pid=${a.pid} rect=${a.rect?.width}x${a.rect?.height}`)

const before = await s.look({ maxWidth: 640 })
console.log('开始前:', before.width + 'x' + before.height)

const t0 = Date.now()
const res = await s.play({
  seconds,
  preset,
  captureEvery: Math.max(5, Math.round(seconds / 2)),
  maxFrames: 2,
})
console.log(`\nplay() 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(JSON.stringify({
  ok: res.ok, seconds: res.seconds, preset: res.preset,
  actions: res.actions, events: res.events, stopped: res.stopped,
  frames: res.frames?.length ?? 0, error: res.error,
}, null, 1))

// 游戏可能在连玩中途退出（比如盲按确认键在菜单里选中了「退出」）——这里要能容忍
let after = null
try {
  after = await s.look({ maxWidth: 640 })
  console.log('结束后:', after.width + 'x' + after.height, 'hash', after.health.hash, '(开始前 hash', before.health.hash + ')')
} catch (e) {
  console.log('结束后读不到画面（游戏可能已退出）:', e.message)
}

mkdirSync('shots', { recursive: true })
writeFileSync('shots/autoplay-before.png', before.png)
if (after) writeFileSync('shots/autoplay-after.png', after.png)
res.frames?.forEach((f, i) => writeFileSync(`shots/autoplay-${i + 1}.png`, f.png))
console.log('截图: shots/autoplay-before.png / autoplay-1..N.png / autoplay-after.png')

// 结束时应没有任何键被按住
const st = await s.status().catch(() => null)
if (st) console.log('队列:', JSON.stringify(st.queue))
await s.dispose('probe-done')

/**
 * probe/hang-diagnose.mjs —— 最小化复现 play-loop-check 卡住的问题
 * 只跑一次 play()，每秒打印一次策略在干什么。
 */
import { GameSession } from '../lib/game.mjs'

const W = 96, H = 64
const mkFrame = (seed) => {
  const buf = Buffer.alloc(W * H * 4, 40)
  for (let i = 0; i < buf.length; i += 4) {
    const px = i / 4
    buf[i] = (px + seed) % 256
    buf[i + 1] = (px * 3 + seed * 7) % 256
    buf[i + 2] = (px * 5 + seed * 11) % 256
    buf[i + 3] = 255
  }
  const hx0 = Math.floor(W * 0.03), hx1 = Math.floor(W * 0.32)
  const hy0 = Math.floor(H * 0.08), hy1 = Math.floor(H * 0.20)
  for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) {
    const i = (y * W + x) * 4
    buf[i] = 230; buf[i + 1] = 250; buf[i + 2] = 255
  }
  return buf
}

let tick = 0
const backend = {
  dead: false,
  async start() { return { koffiOk: true } },
  async alive() { return { ok: true, alive: true, minimized: false, rect: { width: 1600, height: 900 } } },
  async find() { return { ok: true, found: true, hwnd: 4242, pid: 777, rect: { width: 1600, height: 900 }, minimized: false, foreground: true } },
  async getForeground() { return { ok: true, hwnd: 999 } },
  async focus() { return { ok: true, isTarget: true } },
  async capture() { tick++; return { ok: true, width: W, height: H, ms: 1, data: mkFrame(tick) } },
  async keydown(k) { console.log('    keydown', k) },
  async keyup(k) { console.log('    keyup', k) },
  async releaseAll() { return { ok: true } },
  async dispose() { return true },
}

const s = new GameSession({ getConfig: () => ({}), log: () => {} })
s.backend = backend
s.hwnd = 4242
s.pid = 777

console.log('开始 play(6s, advance)…')
const t0 = Date.now()
const timer = setInterval(() => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] 还在跑…`), 1000)
try {
  const res = await s.play({ seconds: 6, preset: 'advance', maxFrames: 0 })
  console.log('结果:', JSON.stringify({ seconds: res.seconds, actions: res.actions, stopped: res.stopped }))
} catch (e) {
  console.log('抛错:', e.message)
} finally {
  clearInterval(timer)
}
process.exit(0)

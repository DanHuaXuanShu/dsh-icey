/**
 * probe/debug-frozen.mjs —— 冻结场景下 play() 到底走了哪些分支
 */
import { GameSession } from '../lib/game.mjs'

const W = 96, H = 64
const frame = (() => {
  const buf = Buffer.alloc(W * H * 4, 40)
  for (let i = 0; i < buf.length; i += 4) {
    const px = i / 4
    buf[i] = (px + 1) % 256
    buf[i + 1] = (px * 3 + 7) % 256
    buf[i + 2] = (px * 5 + 11) % 256
    buf[i + 3] = 255
  }
  const hx0 = Math.floor(W * 0.03), hx1 = Math.floor(W * 0.32)
  const hy0 = Math.floor(H * 0.08), hy1 = Math.floor(H * 0.20)
  for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) {
    const i = (y * W + x) * 4
    buf[i] = 230; buf[i + 1] = 250; buf[i + 2] = 255
  }
  return buf
})()

const keys = []
let held = new Set()
const backend = {
  dead: false,
  async start() { return { koffiOk: true } },
  async alive() { return { ok: true, alive: true, minimized: false, rect: { width: 1600, height: 900 } } },
  async find() { return { ok: true, found: true, hwnd: 4242, pid: 777, rect: { width: 1600, height: 900 }, minimized: false, foreground: true } },
  async getForeground() { return { ok: true, hwnd: 999 } },
  async focus() { return { ok: true, isTarget: true } },
  async capture() { return { ok: true, width: W, height: H, ms: 1, data: frame } },
  async keydown(k) { held.add(k); keys.push(['down', k]) },
  async keyup(k) { held.delete(k); keys.push(['up', k]) },
  async releaseAll() { held = new Set(); return { ok: true } },
  async dispose() { return true },
}

const s = new GameSession({ getConfig: () => ({}), log: () => {} })
s.backend = backend
s.hwnd = 4242
s.pid = 777

// 先单独验证 lookCrop 在假后端下能不能用
try {
  const cut = await s.lookCrop({ x0: 0.30, y0: 0.35, x1: 0.99, y1: 0.90 })
  console.log('lookCrop ok:', cut.width + 'x' + cut.height, 'score:', cut.promptScore)
} catch (e) {
  console.log('lookCrop 抛错:', e.message)
}

const res = await s.play({ seconds: 25, maxFrames: 0, preset: 'advance' })
console.log('seconds:', res.seconds.toFixed(1), '| stopped:', res.stopped)
console.log('actions:', JSON.stringify(res.actions))
console.log('events:', JSON.stringify(res.events))
console.log('blocked:', res.blocked, '| promptSeen:', res.promptSeen, '| promptText:', res.promptText)
console.log('frames:', res.frames.map((f) => f.reason || 'periodic'))
console.log('按键序列:', keys.map(([k, v]) => `${v}:${k}`).join(' '))
process.exit(0)

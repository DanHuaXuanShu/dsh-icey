/**
 * probe/play-loop-check.mjs —— 不开游戏，验证 play() 的整条循环
 *
 * 做法：把 GameSession 的**原生后端换成一个假后端**（合成帧 + 只记录按键），
 * 然后真的调 play()。这样能验证：
 *   - 循环能跑满时长并正常退出
 *   - 画面在动 → 会往右走/攻击
 *   - 画面冻住 → 会按确认键，然后**自己停下来**（不死循环）
 *   - 结束后一定松键、焦点一定还、playing 状态清空、没有残留按键
 *
 * 这测的是「我们自己的编排逻辑」，不是游戏本身。
 */
import { GameSession } from '../lib/game.mjs'

const W = 96, H = 64

/**
 * 造一帧合成画面；seed 变化 ⇒ 画面在动。
 * 同时**涂一块明亮的 HUD**（左上角），否则策略会判定"还没进游戏"而只按确认键 ——
 * 那测的就不是推进逻辑了。
 */
function makeFrame(seed) {
  const buf = Buffer.alloc(W * H * 4, 40)
  for (let i = 0; i < buf.length; i += 4) {
    const px = i / 4
    buf[i] = (px + seed) % 256
    buf[i + 1] = (px * 3 + seed * 7) % 256
    buf[i + 2] = (px * 5 + seed * 11) % 256
    buf[i + 3] = 255
  }
  // HUD 区域（跟 autoplay.HUD_BOX 一致：x 3%~32%，y 8%~20%）涂亮
  const hx0 = Math.floor(W * 0.03), hx1 = Math.floor(W * 0.32)
  const hy0 = Math.floor(H * 0.08), hy1 = Math.floor(H * 0.20)
  for (let y = hy0; y < hy1; y++) {
    for (let x = hx0; x < hx1; x++) {
      const i = (y * W + x) * 4
      buf[i] = 230; buf[i + 1] = 250; buf[i + 2] = 255   // 亮青，跟血条一个调
    }
  }
  return buf
}

/** 假后端：只记录按键，返回合成帧 */
function makeBackend({ frozen = false, found = true } = {}) {
  let tick = 0
  const keys = []
  let held = new Set()
  return {
    dead: false,
    koffiOk: true,
    koffi: '(fake)',
    lastError: '',
    keys,
    get held() { return [...held] },
    async start() { return { koffi: '(fake)', koffiOk: true } },
    async alive() { return { ok: true, alive: true, minimized: false, rect: { width: 1600, height: 900 } } },
    async find() {
      if (!found) return { ok: true, found: false, windows: [] }
      return { ok: true, found: true, hwnd: 4242, pid: 777, title: 'ICEY', rect: { width: 1600, height: 900 }, minimized: false, foreground: true }
    },
    async getForeground() { return { ok: true, hwnd: 999, title: 'DSH（假）' } },
    async focus() { return { ok: true, isTarget: true, requested: true } },
    async capture() {
      tick++
      // frozen=true 时每帧完全一样 ⇒ motion≈0
      return { ok: true, width: W, height: H, ms: 1, data: makeFrame(frozen ? 1 : tick) }
    },
    async keydown(k) { held.add(k); keys.push(['down', k]); return { ok: true } },
    async keyup(k) { held.delete(k); keys.push(['up', k]); return { ok: true } },
    async releaseAll() { held = new Set(); return { ok: true, released: [] } },
    async dispose() { return true },
  }
}

/**
 * 直接用假后端装配一个 GameSession（绕开 ensureBackend 的真 worker）
 * @returns {GameSession}
 */
function makeSession(opts) {
  const s = new GameSession({ getConfig: () => ({}), log: () => {} })
  s.backend = makeBackend(opts)
  s.hwnd = 4242
  s.pid = 777
  return s
}

const fails = []
const ok = (name, cond, extra) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra && !cond ? ' — ' + extra : ''}`); if (!cond) fails.push(name) }

/* ---------- ① 画面在动：应该自己往前走 ---------- */
console.log('\n[1] 画面在动 → 自主推进')
{
  const s = makeSession({ frozen: false })
  const t0 = Date.now()
  const res = await s.play({ seconds: 6, preset: 'advance', maxFrames: 1, captureEvery: 5 })
  const ms = Date.now() - t0
  ok('play 返回 ok', res.ok === true, JSON.stringify(res.error))
  ok('停在了「玩满」', /玩满/.test(res.stopped || ''), res.stopped)
  ok('时长合理（4–20 秒）', ms > 4000 && ms < 20000, ms + 'ms')
  const total = Object.values(res.actions || {}).reduce((a, b) => a + b, 0)
  ok('确实做了动作', total > 0, JSON.stringify(res.actions))
  ok('有前进动作', (res.actions?.move || 0) > 0, JSON.stringify(res.actions))
  ok('结束后没有按住的键', s.backend.held.length === 0, s.backend.held.join(','))
  ok('playing 状态已清空', s.playing === null, String(s.playing))
  ok('焦点还原字段已清空', s.pendingRestoreHwnd === 0, String(s.pendingRestoreHwnd))
  ok('有途中截图或明确没有', (res.frames?.length ?? 0) >= 0, '')
  console.log('    动作:', JSON.stringify(res.actions), '| 停止:', res.stopped)
}

/* ---------- ② 画面冻住：应该按确认，然后自己停 ---------- */
console.log('\n[2] 画面冻住 → 按确认关，然后自己停下（不死循环）')
{
  const s = makeSession({ frozen: true })
  const t0 = Date.now()
  const res = await s.play({ seconds: 25, preset: 'advance', maxFrames: 0 })
  const ms = Date.now() - t0
  ok('play 返回 ok', res.ok === true, JSON.stringify(res.error))
  ok('因为「连续不动」主动停下', /没进展|连续/.test(res.stopped || ''), res.stopped)
  ok('没跑满 25 秒就收手（<20 秒）', ms < 20000, ms + 'ms')
  ok('按过确认键', (res.actions?.interact || 0) > 0, JSON.stringify(res.actions))
  ok('结束后没有按住的键', s.backend.held.length === 0, s.backend.held.join(','))
  ok('playing 状态已清空', s.playing === null, String(s.playing))
  console.log('    动作:', JSON.stringify(res.actions), '| 停止:', res.stopped)
}

/* ---------- ③ 不能操作时如实拒绝 ---------- */
console.log('\n[3] 没接上 / 不能操作 → 如实报错，不假装在玩')
{
  // 注意：不要让它去 ensureBackend()（那会真的起一个 worker）。给一个「找不到游戏」的假后端。
  const s = new GameSession({ getConfig: () => ({}), log: () => {} })
  s.backend = makeBackend({ found: false })
  s.hwnd = 0
  const res = await s.play({ seconds: 5 })
  ok('没接上时 ok=false', res.ok === false, JSON.stringify(res))
  ok('给出了原因', /接上|窗口/.test(res.error || ''), res.error)
}

/* ---------- ④ 参数被夹住（不能把 seconds 传成 99999） ---------- */
console.log('\n[4] 参数夹紧')
{
  const s = makeSession({ frozen: true })
  const res = await s.play({ seconds: 99999, preset: 'nonsense', maxFrames: 99 })
  ok('未知 preset 回落 advance', res.preset === 'advance', res.preset)
  ok('maxFrames 被夹到 ≤4', (res.frames?.length ?? 0) <= 4, String(res.frames?.length))
  ok('没有因为超大 seconds 挂住（冻结场景会提前停）', /没进展|玩满/.test(res.stopped || ''), res.stopped)
  ok('结束后没有按住的键', s.backend.held.length === 0, s.backend.held.join(','))
}

console.log(`\n${fails.length ? '❌' : '✅'} ${fails.length ? fails.length + ' 项失败' : '全部通过'}`)
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1) }
// GameSession 的队列/定时器会挂住事件循环，测试跑完显式退出
process.exit(0)

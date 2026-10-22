/**
 * selfcheck.mjs —— 纯 Node 自检：不需要 DSH、不需要 ICEY 在跑
 *   node selfcheck.mjs
 * 覆盖：PNG 编码/解码往返、像素加工、控制映射、队列与冷却、Config 解析。
 */
import { encodePng, bgraToRgba, resizeRgba, cropRgba, fitWidth, frameHash, nonBlackRatio, diffRatio } from './lib/png.mjs'
import { inflateSync } from 'node:zlib'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`) }

/* ---------- 1. PNG 往返 ---------- */
console.log('\n[1] PNG 编码往返')
{
  const w = 17, h = 9
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7) & 0xff
    rgba[i * 4 + 1] = (i * 13) & 0xff
    rgba[i * 4 + 2] = (i * 29) & 0xff
    rgba[i * 4 + 3] = 255
  }
  const png = encodePng(w, h, rgba)
  ok('PNG 签名正确', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
  ok('IHDR 尺寸正确', png.readUInt32BE(16) === w && png.readUInt32BE(20) === h, `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`)
  ok('IHDR 是 8bit RGBA', png[24] === 8 && png[25] === 6, `depth=${png[24]} color=${png[25]}`)
  ok('以 IEND 结尾', png.subarray(png.length - 8, png.length - 4).toString('ascii') === 'IEND')
  // 解回来比对像素
  let at = 8, idat = null, w2 = 0, h2 = 0
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const data = png.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') { w2 = data.readUInt32BE(0); h2 = data.readUInt32BE(4) }
    if (type === 'IDAT') idat = data
    at += 12 + len
  }
  const raw = inflateSync(idat)
  const stride = w2 * 4
  let same = true
  for (let y = 0; y < h2; y++) {
    const base = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) if (raw[base + x] !== rgba[y * stride + x]) { same = false; break }
    if (!same) break
  }
  ok('PNG 往返像素一致', same)
  ok('chunk CRC 全部有效', (() => {
    let a = 8
    const table = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
    while (a < png.length) {
      const len = png.readUInt32BE(a)
      const span = png.subarray(a + 4, a + 8 + len)
      let c = 0xffffffff
      for (let i = 0; i < span.length; i++) c = table[(c ^ span[i]) & 0xff] ^ (c >>> 8)
      if (((c ^ 0xffffffff) >>> 0) !== png.readUInt32BE(a + 8 + len)) return false
      a += 12 + len
    }
    return true
  })())
}

/* ---------- 2. 像素加工 ---------- */
console.log('\n[2] 像素加工')
{
  const bgra = Buffer.from([10, 20, 30, 255])
  eq('BGRA→RGBA 通道交换', [...bgraToRgba(bgra)], [30, 20, 10, 255])
  const src = Buffer.alloc(4 * 4 * 4, 0)
  for (let i = 0; i < 16; i++) { src[i * 4] = 100; src[i * 4 + 1] = 150; src[i * 4 + 2] = 200; src[i * 4 + 3] = 255 }
  const down = resizeRgba(src, 4, 4, 2, 2)
  eq('缩放尺寸', [down.length], [2 * 2 * 4])
  ok('缩放颜色保持', down[0] === 100 && down[1] === 150 && down[2] === 200 && down[3] === 255)
  const c = cropRgba(src, 4, 4, 1, 1, 2, 2)
  eq('裁剪尺寸', [c.width, c.height, c.data.length], [2, 2, 16])
  ok('裁剪内容正确', c.data[0] === 100 && c.data[3] === 255)
  const fit = fitWidth(src, 4, 4, 2)
  eq('fitWidth 缩小', [fit.width, fit.height], [2, 2])
  const same = fitWidth(src, 4, 4, 100)
  eq('fitWidth 不放大', [same.width, same.height], [4, 4])
  ok('frameHash 稳定', frameHash(src) === frameHash(Buffer.from(src)))
  ok('frameHash 对变化敏感', frameHash(src) !== frameHash(Buffer.concat([Buffer.from([1, 2, 3, 4]), src.subarray(4)])))
  ok('nonBlackRatio 全亮 = 1', nonBlackRatio(src) === 1)
  ok('nonBlackRatio 全黑 = 0', nonBlackRatio(Buffer.alloc(64)) === 0)
  ok('diffRatio 相同 = 0', diffRatio(src, src) === 0)
  const other = Buffer.from(src); other[0] = 250
  ok('diffRatio 有差异 > 0', diffRatio(src, other) > 0)
}

/* ---------- 3. 控制映射 ---------- */
console.log('\n[3] 控制映射')
{
  const { DEFAULT_KEYMAP, planAction, ACTION_SPECS } = await import('./lib/control.mjs')
  ok('默认键位与 ICEY 一致', DEFAULT_KEYMAP.moveLeft === 'a' && DEFAULT_KEYMAP.moveRight === 'd' &&
    DEFAULT_KEYMAP.moveUp === 'w' && DEFAULT_KEYMAP.moveDown === 's' &&
    DEFAULT_KEYMAP.attack === 'j' && DEFAULT_KEYMAP.jump === ' ' &&
    DEFAULT_KEYMAP.heavy === 'i' && DEFAULT_KEYMAP.execute === 'l' &&
    DEFAULT_KEYMAP.dash === 'o' && DEFAULT_KEYMAP.chase === 'u',
    JSON.stringify(DEFAULT_KEYMAP))
  ok('动作清单齐全', ['move', 'attack', 'heavy', 'execute', 'jump', 'dash', 'menu', 'pause', 'interact'].every((a) => a in ACTION_SPECS), Object.keys(ACTION_SPECS).join(','))
  const move = planAction({ action: 'move', dir: 'right', ms: 800 })
  eq('move right → 按住 d', move.steps.map((s) => [s.key, s.holdMs]), [['d', 800]])
  const moveD = planAction({ action: 'move', dir: 'down', ms: 500 })
  eq('move down → 按住 s', moveD.steps.map((s) => [s.key, s.holdMs]), [['s', 500]])
  const atk = planAction({ action: 'attack', ms: 300 })
  eq('attack → 点 j', atk.steps.map((s) => [s.key, s.holdMs]), [['j', 300]])
  const jump = planAction({ action: 'jump' })
  eq('jump → 点空格', jump.steps.map((s) => [s.key, s.holdMs]), [[' ', jump.steps[0].holdMs]])
  const dash = planAction({ action: 'dash', dir: 'left' })
  eq('dash left → 按住 a', dash.steps.map((s) => s.key), ['a'])
  const pause = planAction({ action: 'pause' })
  eq('pause → Esc', pause.steps.map((s) => s.key), ['Escape'])
  const menu = planAction({ action: 'menu', item: 'resume' })
  eq('menu resume → Enter', menu.steps.map((s) => s.key), ['Enter'])
  let threw = null
  try { planAction({ action: 'nope' }) } catch (e) { threw = e.message }
  ok('未知动作报错', !!threw, threw)
  let threw2 = null
  try { planAction({ action: 'move' }) } catch (e) { threw2 = e.message }
  ok('move 缺 dir 报错', !!threw2, threw2)
  const clamped = planAction({ action: 'attack', ms: 99999 })
  ok('按住时长被夹到上限', clamped.steps[0].holdMs <= 5000, String(clamped.steps[0].holdMs))
  // 自定义键位
  const custom = planAction({ action: 'attack', ms: 200 }, { keyMap: { ...DEFAULT_KEYMAP, attack: 'k' } })
  eq('自定义键位生效', custom.steps.map((s) => s.key), ['k'])
}

/* ---------- 4. 队列 / 冷却 / releaseAll ---------- */
console.log('\n[4] 动作队列')
{
  const { ActionQueue } = await import('./lib/control.mjs')
  const ran = []
  let releases = 0
  const q = new ActionQueue({
    cooldownMs: 50,
    maxQueue: 4,
    run: async (job) => { ran.push(job.id ?? job.qid); await new Promise((r) => setTimeout(r, 20)) },
    releaseAll: async () => { releases++ },
  })
  const a = await q.push({ id: 'a' })
  const b = await q.push({ id: 'b' })
  ok('两个动作都排上了', a.accepted && b.accepted, JSON.stringify({ a, b }))
  await new Promise((r) => setTimeout(r, 300))
  eq('按顺序执行', ran, ['a', 'b'])
  // 队列满
  const jobs = []
  for (let i = 0; i < 8; i++) jobs.push(q.push({ id: `x${i}` }))
  const results = await Promise.all(jobs)
  ok('超容量被拒', results.some((r) => !r.accepted), JSON.stringify(results.map((r) => r.accepted)))
  await new Promise((r) => setTimeout(r, 600))
  await q.dispose()
  ok('dispose 调用了 releaseAll', releases >= 1, String(releases))
  const after = await q.push({ id: 'late' })
  ok('dispose 后拒绝新动作', after.accepted === false, JSON.stringify(after))
}

/* ---------- 5. Config 解析 ---------- */
console.log('\n[5] Config 解析')
{
  const { normalizeConfig, DEFAULTS } = await import('./lib/config.mjs')
  const d = normalizeConfig({})
  eq('空配置用默认 launchMode', d.launchMode, 'attach')
  eq('空配置用默认 fps', d.fps, 10)
  ok('fps 被夹到 ≤15', normalizeConfig({ fps: 999 }).fps <= 15, String(normalizeConfig({ fps: 999 }).fps))
  ok('fps 下限 ≥1', normalizeConfig({ fps: 0 }).fps >= 1, String(normalizeConfig({ fps: 0 }).fps))
  eq('未知 launchMode 回落到 attach', normalizeConfig({ launchMode: 'weird' }).launchMode, 'attach')
  eq('合法 launchMode 保留', normalizeConfig({ launchMode: 'steam' }).launchMode, 'steam')
  const km = normalizeConfig({ keyMap: { attack: 'k' } }).keyMap
  eq('部分 keyMap 与默认合并', [km.attack, km.moveRight], ['k', 'd'])
  ok('默认键位没被污染', DEFAULTS.keyMap.attack === 'j', DEFAULTS.keyMap.attack)
  ok('maxFrameWidth 有上限', normalizeConfig({ maxFrameWidth: 99999 }).maxFrameWidth <= 1568, String(normalizeConfig({ maxFrameWidth: 99999 }).maxFrameWidth))
  eq('steamAppId 默认 553640', normalizeConfig({}).steamAppId, '553640')
}

/* ---------- 汇总 ---------- */
console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 项通过，${fails.length} 项失败`)
if (fails.length) {
  for (const f of fails) console.log(`   - ${f}`)
  process.exit(1)
}

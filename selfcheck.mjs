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

/* ---------- 6. 自主连玩策略 ---------- */
console.log('\n[6] 自主连玩策略')
{
  const { analyzeFrame, createPolicy, PRESETS, summarizeRun, STILL_MOTION, FIGHT_HUDKICK, PRESENCE_BRIGHT, PROGRESS_MIN, UNSTUCK_LADDER, MAX_INTERACTS, MAX_BOOT_INTERACTS, PROMPT_MIN, ACTION_WEIGHTS, SUBTITLE_MIN, pickWeighted, COMBOS, analyzeEnvironment, DESTRUCT_SAT, SEAM_DIFF, VFX_DANGER, createChestTracker } = await import('./lib/autoplay.mjs')

  // 造一帧：全填同一个颜色
  const mk = (w, h, v) => { const b = Buffer.alloc(w * h * 4, v); return b }
  const W = 80, H = 60

  // ① analyzeFrame：同帧 → 不动
  const a1 = analyzeFrame(mk(W, H, 100), W, H, null)
  ok('首帧没有 motion（没有参照）', a1.ok && a1.motion === null, JSON.stringify(a1.motion))
  const prev = { rgba: mk(W, H, 100), width: W, height: H, hud: a1.hud }
  const a2 = analyzeFrame(mk(W, H, 100), W, H, prev)
  ok('同两帧 → motion=0', a2.motion === 0, String(a2.motion))

  // ② 完全变了 → motion 接近 1
  const a3 = analyzeFrame(mk(W, H, 250), W, H, prev)
  ok('整屏变化 → motion 接近 1', a3.motion > 0.9, String(a3.motion))

  // ③ HUD 区域变化会体现在 hudKick 上（血条在左上那一带）
  const hudFrame = mk(W, H, 100)
  // HUD 区域（按比例算）填亮色
  const hx0 = Math.floor(W * 0.03), hx1 = Math.floor(W * 0.32)
  const hy0 = Math.floor(H * 0.08), hy1 = Math.floor(H * 0.20)
  for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) {
    const i = (y * W + x) * 4
    hudFrame[i] = 255; hudFrame[i + 1] = 255; hudFrame[i + 2] = 0
  }
  const a4 = analyzeFrame(hudFrame, W, H, { rgba: mk(W, H, 100), width: W, height: H, hud: a1.hud })
  ok('HUD 变亮 → hudKick 变正', a4.hudKick > 0, String(a4.hudKick))

  // ④ 边界：帧数据不完整不能崩
  const bad = analyzeFrame(Buffer.alloc(10), 80, 60, null)
  ok('数据不完整返回 ok:false', bad.ok === false, JSON.stringify(bad))

  // ⑤ 策略：画面静止 → 不是乱走，而是「反向挪一下」或「按确认」
  const p1 = createPolicy('advance')
  const d1 = p1.decide({ motion: 0, hudKick: 0 }, { now: 0 })
  ok('静止第 1 次 → 反向挪（不是继续走）', d1.action === 'move' && d1.dir === 'left', JSON.stringify(d1))
  // 第 2 下是**通用互动键 Enter**（PlayerPrefs 里叫 Search）
  const d2 = p1.decide({ motion: 0, hudKick: 0 }, { now: 2000 })
  ok('静止第 2 次 → 按 Enter（通用互动键）', d2.action === 'interact', JSON.stringify(d2))
  // 第 3 下是跳（Enter 刚按过，别连点）
  const dStuck3 = p1.decide({ motion: 0, hudKick: 0 }, { now: 2400 })
  ok('静止第 3 次 → 跳（Enter 刚按过）', dStuck3.action === 'jump', JSON.stringify(dStuck3))
  ok('Enter 有节流（刚按过不会连点）', p1.decide({ motion: 0, hudKick: 0 }, { now: 2500 }).action !== 'interact', 'throttled')

  // ⑥ 策略：HUD 在跳 → 打架，出攻击/重击
  const p2 = createPolicy('advance')
  const fightMoves = []
  for (let i = 0; i < 6; i++) fightMoves.push(p2.decide({ motion: 0.3, hudKick: FIGHT_HUDKICK + 0.05 }, { now: i * 100 }))
  ok('在打架时只出战斗动作（含闪避/位移）', fightMoves.every((d) => ['attack', 'heavy', 'dash', 'move', 'jump', 'chase', 'execute', 'storm', 'shade', 'combo'].includes(d.action)), fightMoves.map((d) => d.action).join(','))
  ok('在打架时确实会攻击（含连段）', fightMoves.some((d) => d.action === 'attack' || d.action === 'combo' || d.action === 'heavy'), fightMoves.map((d) => d.action).join(','))

  // ⑦ 策略：正常推进 → 走右
  const p3 = createPolicy('advance')
  const d3 = p3.decide({ motion: 0.2, hudKick: 0 }, { now: 0 })
  ok('正常情况会往右推进', d3.action === 'move' && d3.dir === 'right', JSON.stringify(d3))

  // ⑧ 确定性：同样的输入序列 → 同样的动作序列（所以能离线单测）
  const runSeq = (preset) => {
    const p = createPolicy(preset)
    return [0, 1, 2, 3, 4, 5].map((i) => p.decide({ motion: 0.2, hudKick: 0 }, { now: i * 100 }).action).join(',')
  }
  eq('策略是确定性的', runSeq('advance'), runSeq('advance'))

  // ⑨ 三个预设都能出动作，且 fight 不出移动
  ok('explore 存在且有描述', !!PRESETS.explore?.desc, PRESETS.explore?.desc)
  const p4 = createPolicy('fight')
  const fm = Array.from({ length: 4 }, (_, i) => p4.decide({ motion: 0.2, hudKick: 0 }, { now: i * 100 }).action)
  ok('fight 预设不走路', !fm.includes('move'), fm.join(','))

  // ⑩ 未知预设回落到 advance（不抛错）
  const p5 = createPolicy('nonsense')
  eq('未知预设回落到 advance', p5.preset, 'advance')

  // ⑪ 摘要可读且包含关键信息
  const sum = summarizeRun({ seconds: 12.3, preset: 'advance', actions: { move: 5, attack: 3 }, events: ['第 4s 进入战斗'], frames: 2, stopped: '玩满 12 秒' })
  ok('摘要有秒数', sum.includes('12.3'), sum)
  ok('摘要有动作统计', sum.includes('move×5'), sum)
  ok('摘要有停止原因', sum.includes('玩满'), sum)
  ok('摘要有截图数量', sum.includes('2 张'), sum)
  // play() 返回的是**数组**，summarizeRun 不能把它插值成 [object Object]
  const sum2 = summarizeRun({ seconds: 5, preset: 'advance', actions: { move: 1 }, events: [], frames: [{}, {}], stopped: '玩满 5 秒' })
  ok('frames 是数组时也说对话', sum2.includes('2 张') && !sum2.includes('[object'), sum2)
  ok('STILL_MOTION 是合理小值', STILL_MOTION > 0 && STILL_MOTION < 0.05, String(STILL_MOTION))

  // ⑫ 没检测到 HUD（标题/加载）⇒ 按确认键，而不是继续空走 —— 2026-10-23 真机踩到的坑：
  //    标题界面有飘雪，motion 一直 1.5~2%，光靠 motion 永远等不到"卡住"。
  const p6 = createPolicy('advance')
  const noHud1 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 0 })
  ok('没有 HUD 时第一反应是按确认键', noHud1.action === 'interact', JSON.stringify(noHud1))
  const noHud2 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 300 })
  ok('确认键有节流，紧接着是等一等（不连点）', noHud2.action === 'wait', JSON.stringify(noHud2))
  const noHud3 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 2000 })
  ok('节流过后会再次按确认键', noHud3.action === 'interact', JSON.stringify(noHud3))

  // ⑬ 有 HUD（在游戏里）时，同样的 motion 应该走正常推进逻辑
  const p7 = createPolicy('advance')
  const hasHud = p7.decide({ motion: 0.02, hudKick: 0, hudBright: 0.08 }, { now: 0 })
  ok('检测到 HUD 时不会乱按确认键', hasHud.action !== 'interact', JSON.stringify(hasHud))
  ok('PRESENCE_BRIGHT 是合理小值', PRESENCE_BRIGHT > 0 && PRESENCE_BRIGHT < 0.05, String(PRESENCE_BRIGHT))

  // ⑭ hudBright 真的能从画面算出来（HUD 区域涂亮 → 占比升高）
  const withBar = mk(W, H, 20)
  for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) {
    const i = (y * W + x) * 4
    withBar[i] = 255; withBar[i + 1] = 255; withBar[i + 2] = 255
  }
  const a5 = analyzeFrame(withBar, W, H, null)
  const aDark = analyzeFrame(mk(W, H, 20), W, H, null)
  ok('全亮 HUD → hudBright 接近 1', a5.hudBright > 0.9, String(a5.hudBright))
  ok('全暗画面 → hudBright 接近 0', aDark.hudBright < 0.01, String(aDark.hudBright))

  // ⑮ 原地踏步：相邻帧有 motion（待机动画），但 2.5 秒净进展为 0 ⇒ 必须当成卡住
  //    —— 2026-10-23 真机踩到：卡在大门前，motion 一直 1.5%，策略以为在走，白按了 15 秒。
  const p8 = createPolicy('advance')
  const d8 = p8.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01 }, { now: 0 })
  ok('净进展为 0 时不会继续往原方向傻走', !(d8.action === 'move' && d8.dir === 'right'), JSON.stringify(d8))
  ok('净进展为 0 时先反向挪/按确认', ['move', 'interact'].includes(d8.action) && (d8.action === 'interact' || d8.dir === 'left'), JSON.stringify(d8))

  // ⑯ 有净进展时正常推进
  const p9 = createPolicy('advance')
  const d9 = p9.decide({ motion: 0.03, hudKick: 0, hudBright: 0.08, progress: 0.6 }, { now: 0 })
  ok('有净进展时继续推进', d9.action === 'move' && d9.dir === 'right', JSON.stringify(d9))
  ok('PROGRESS_MIN 是合理阈值', PROGRESS_MIN > 0.01 && PROGRESS_MIN < 0.3, String(PROGRESS_MIN))

  // ⑰ 净进展缺失（null，比如刚开局还没攒够参照帧）不影响正常推进
  const p10 = createPolicy('advance')
  const d10 = p10.decide({ motion: 0.03, hudKick: 0, hudBright: 0.08, progress: null }, { now: 0 })
  ok('progress 为 null 时按正常逻辑走', d10.action === 'move' && d10.dir === 'right', JSON.stringify(d10))

  // ⑱ 脱困阶梯：连续卡住时要**换着法子**试，而不是一直撞同一面墙
  const p11 = createPolicy('advance')
  const seq = []
  for (let i = 0; i < 8; i++) {
    seq.push(p11.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01 }, { now: i * 800 }))
  }
  const kinds = seq.map((d) => (d.action === 'move' ? 'back' : d.action === 'heavy' ? 'attack' : d.action))
  ok('阶梯里第一下是退一步', kinds[0] === 'back', kinds.join(','))
  ok('阶梯里会出现按确认', kinds.includes('interact'), kinds.join(','))
  ok('阶梯里会出现跳', kinds.includes('jump'), kinds.join(','))
  ok('阶梯里会出现攻击', kinds.includes('attack'), kinds.join(','))
  ok('不会一直只做同一个动作', new Set(kinds.filter((k) => k !== 'wait')).size >= 3, kinds.join(','))
  ok('UNSTUCK_LADDER 是 5 步', UNSTUCK_LADDER.length === 5, JSON.stringify(UNSTUCK_LADDER))
  ok('阶梯第二下是 Enter（唯一的互动键）', UNSTUCK_LADDER[1] === 'interact', JSON.stringify(UNSTUCK_LADDER))
  ok('阶梯里不再有 J（J 只是攻击）', !UNSTUCK_LADDER.includes('j'), JSON.stringify(UNSTUCK_LADDER))

  // ⑲ 一整轮阶梯都失败 ⇒ 必须「掉头」而不是继续撞；且方向真的翻了
  const p12 = createPolicy('advance')
  let flip = null
  for (let i = 0; i < 10; i++) {
    const d = p12.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01 }, { now: i * 900 })
    if (/掉头/.test(d.why || '')) { flip = d; break }
  }
  ok('一轮阶梯后会掉头', !!flip, flip ? JSON.stringify(flip) : '没有出现掉头')
  if (flip) {
    ok('掉头是往反方向走', flip.action === 'move' && flip.dir === 'left', JSON.stringify(flip))
    ok('掉头会走远一点（≥1 秒）', (flip.ms || 0) >= 1000, String(flip.ms))
    ok('掉头之后推进方向也翻了', p12.dir === 'left', p12.dir)
  }

  // ⑳ 打架时会用「追击（U）」拉近距离 —— 招式表里 Chase 就是干这个的
  const pChase = createPolicy('advance')
  const seqFight = []
  for (let i = 0; i < 30; i++) {
    seqFight.push(pChase.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 300 }))
  }
  ok('打架时会用追击（chase）', seqFight.some((d) => d.action === 'chase'), [...new Set(seqFight.map((d) => d.action))].join(','))
  ok('打架时也会闪现（dash）', seqFight.some((d) => d.action === 'dash'), [...new Set(seqFight.map((d) => d.action))].join(','))

  // 阶梯最后一步必须是 Esc：万一 Enter 打开了招式升级界面（那里的 Enter 是花钱升级），Esc 能安全退出
  ok('阶梯最后一步是 Esc（安全退出菜单）', UNSTUCK_LADDER[UNSTUCK_LADDER.length - 1] === 'escape', JSON.stringify(UNSTUCK_LADDER))

  // ㉑ 看到互动提示框就直接按 Enter（这是最可信的「这里能互动」信号）
  //    实测：无提示 0.019%，有提示 0.23~0.40%
  const pP = createPolicy('advance')
  const dP = pP.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01, promptBright: 0.003 }, { now: 0 })
  ok('看到提示框时按 Enter 互动', dP.action === 'interact', JSON.stringify(dP))
  ok('提示原因的文案说清了依据', /提示框/.test(dP.why || ''), dP.why)
  const pN = createPolicy('advance')
  const dN = pN.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01, promptBright: 0.0002 }, { now: 0 })
  ok('提示框信号很弱时不盲按 Enter', dN.action !== 'interact', JSON.stringify(dN))
  ok('PROMPT_MIN 落在实测区间内', PROMPT_MIN > 0.0001 && PROMPT_MIN < 0.002, String(PROMPT_MIN))

  // ㉘ 实战数据学到的预警闪避：亮闪≥VFX_DANGER 就先闪（24 分钟数据：大伤害前 6.61% vs 全局 4.09%）
  ok('VFX_DANGER 落在实测区间（4.09% 与 6.61% 之间）', VFX_DANGER > 0.041 && VFX_DANGER < 0.066, String(VFX_DANGER))
  const pVfx = createPolicy('advance')
  const dVfx = pVfx.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.07 }, { now: 0 })
  ok('亮闪升高时先闪避而不是硬打', dVfx.action === 'dash', JSON.stringify(dVfx))
  ok('闪避理由写明了数据依据', /亮闪/.test(dVfx.why || ''), dVfx.why)
  const pNoVfx = createPolicy('advance')
  const dNoVfx = pNoVfx.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.03 }, { now: 0 })
  ok('亮闪正常时不乱闪', dNoVfx.action !== 'dash' || !/亮闪/.test(dNoVfx.why || ''), JSON.stringify(dNoVfx))

  // ㉓ 行动权重：确定性 + 每个 preset 的权重表都存在
  ok('pickWeighted 是确定性的', pickWeighted(ACTION_WEIGHTS.fight, 42) === pickWeighted(ACTION_WEIGHTS.fight, 42), '')
  ok('advance/explore/fight 都有权重表', !!(ACTION_WEIGHTS.advance && ACTION_WEIGHTS.fight && ACTION_WEIGHTS.explore), Object.keys(ACTION_WEIGHTS).join(','))
    const fightTotal = Object.values(ACTION_WEIGHTS.fight).reduce((a, b) => a + b, 0)
  const atkShare = (ACTION_WEIGHTS.fight.combo + ACTION_WEIGHTS.fight.heavy + ACTION_WEIGHTS.fight.attack) / fightTotal
  const moveShare = (ACTION_WEIGHTS.fight.dash + ACTION_WEIGHTS.fight.chase + (ACTION_WEIGHTS.fight.move || 0)) / fightTotal
  ok('战斗时攻击占比 ≥70%（用户要求攻击欲望高）', atkShare >= 0.7, (atkShare * 100).toFixed(1) + '%')
  ok('战斗时位移占比 ≤10%（用户要求减少位移）', moveShare <= 0.1, (moveShare * 100).toFixed(1) + '%')
  const spread = new Set()
  for (let i = 0; i < 200; i++) spread.add(pickWeighted(ACTION_WEIGHTS.explore, i))
  ok('探索权重能出多种动作（有变化）', spread.size >= 3, [...spread].join(','))

  // ㉔ 跟随旁白：字幕出现时先按确认把话听完，而不是继续乱跑
  const pNar = createPolicy('advance')
  // 连续两帧都有字幕才按（第一帧先等，滤掉一闪而过的亮光误判）
  const dNar0 = pNar.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, subtitle: 0.05 }, { now: 0 })
  ok('旁白第一帧先等一下（不急着按）', dNar0.action === 'wait', JSON.stringify(dNar0))
  const dNar = pNar.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, subtitle: 0.05 }, { now: 900 })
  ok('旁白连续出现时按确认键', dNar.action === 'interact', JSON.stringify(dNar))
  ok('旁白的理由写明了', /旁白/.test(dNar.why || ''), dNar.why)
  ok('SUBTITLE_MIN 是合理阈值', SUBTITLE_MIN > 0.005 && SUBTITLE_MIN < 0.1, String(SUBTITLE_MIN))

  // ㉕ 探索：会掉头换方向扫图（找宝箱/彩蛋）
  const pExp = createPolicy('explore')
  const seqExp = []
  for (let i = 0; i < 40; i++) seqExp.push(pExp.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5 }, { now: i * 400 }))
  ok('探索时会掉头换方向', seqExp.some((d) => /掉头/.test(d.why || '')), [...new Set(seqExp.map((d) => d.action))].join(','))
  // ㉗ 环境感知：可破坏物要「看见才打」，隐藏房间靠接缝分析，不盲砍
  const EW = 320, EH = 180
  const mkEnv = (fn) => { const b = Buffer.alloc(EW * EH * 4, 0); for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = (y * EW + x) * 4; const [r, g, bl] = fn(x, y); b[i] = r; b[i + 1] = g; b[i + 2] = bl; b[i + 3] = 255 } return b }
  const flat = mkEnv((x, y) => { const v = 60 + (y % 7); return [v, v + 2, v + 6] })
  // 宝箱检测已改成模板匹配（真实样本校准）：把模板贴进一张暗背景里，应该被找到
  const { CHEST_TEMPLATE } = await import('./lib/chest-template.mjs')
  const GW = CHEST_TEMPLATE.frameWidth, GH = Math.round(GW * 116 / 200)
  const stampFrame = (applyTemplate) => {
    const b = Buffer.alloc(GW * GH * 4, 0)
    for (let i = 0; i < b.length; i += 4) { b[i] = 40; b[i + 1] = 42; b[i + 2] = 46; b[i + 3] = 255 }
    if (applyTemplate) {
      const ox = 90, oy = 50
      for (let ty = 0; ty < CHEST_TEMPLATE.height; ty++) {
        for (let tx = 0; tx < CHEST_TEMPLATE.width; tx++) {
          const v = CHEST_TEMPLATE.gray[ty * CHEST_TEMPLATE.width + tx]
          const i = ((oy + ty) * GW + (ox + tx)) * 4
          if (i + 2 < b.length) { b[i] = v; b[i + 1] = v; b[i + 2] = v }
        }
      }
    }
    return b
  }
  const envChest = analyzeEnvironment(stampFrame(true), GW, GH)
  const envEmpty = analyzeEnvironment(stampFrame(false), GW, GH)
  ok('贴了宝箱模板 → 检测到', envChest.chest > 0, JSON.stringify(envChest))
  ok('宝箱得分明显高于阈值', envChest.chestScore >= 0.62, String(envChest.chestScore))
  ok('宝箱横向位置正确', Math.abs(envChest.chestX - 0.5) < 0.1, String(envChest.chestX))
  ok('空画面 → 不误报', envEmpty.chest === 0, JSON.stringify(envEmpty))
  const withSeam = mkEnv((x, y) => { const v = x < 160 ? 70 : 120; return [v, v + 2, v + 6] })
  const envFlat = analyzeEnvironment(flat, EW, EH)
  ok('均匀墙面：没有可破坏物', envFlat.destructible === 0, JSON.stringify(envFlat))
  ok('均匀墙面：没有接缝', envFlat.seam === 0, JSON.stringify(envFlat))
  const envSeam = analyzeEnvironment(withSeam, EW, EH)
  ok('竖直接缝：检测到环境异常', envSeam.seam >= SEAM_DIFF, JSON.stringify(envSeam))
  ok('接缝有横向位置', envSeam.seamX > 0.3 && envSeam.seamX < 0.7, String(envSeam.seamX))

  // ㊲ 处决优先级（用户要求）：看到黄圈+头顶L 立刻按 L，处决完长按 J 吸超载
  const pExec = createPolicy('advance')
  const dExec = pExec.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5, executePrompt: true, executeX: 0.6 }, { now: 0 })
  ok('看到处决提示 → 立刻按 L', dExec.action === 'execute', JSON.stringify(dExec))
  ok('处决理由写明了收益', /回血|回盾|结晶/.test(dExec.why || ''), dExec.why)
  const dOver = pExec.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5, executePrompt: false }, { now: 1500 })
  ok('处决之后 → 长按 J 吸收超载', dOver.action === 'overload', JSON.stringify(dOver))

  // ㊳ 权重：连段/重击优先级提高（用户要求）
  ok('连段权重最高', ACTION_WEIGHTS.fight.combo >= 10, JSON.stringify(ACTION_WEIGHTS.fight))
  ok('重击权重至少 6', ACTION_WEIGHTS.fight.heavy >= 6, JSON.stringify(ACTION_WEIGHTS.fight))
  ok('重击权重高于普通攻击', ACTION_WEIGHTS.fight.heavy > ACTION_WEIGHTS.fight.attack, JSON.stringify(ACTION_WEIGHTS.fight))

  // ㊱ 画面箭头跟随：游戏给的方向指引要跟着走
  const pArr = createPolicy('advance')
  const dArr = pArr.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, arrowDir: 'right' }, { now: 0 })
  ok('看到箭头 → 按箭头方向走', dArr.action === 'move' && dArr.dir === 'right', JSON.stringify(dArr))
  ok('箭头理由说清了', /箭头/.test(dArr.why || ''), dArr.why)
  const pArrL = createPolicy('advance')
  const dArrL = pArrL.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, arrowDir: 'left' }, { now: 0 })
  ok('箭头向左 → 往左走', dArrL.action === 'move' && dArrL.dir === 'left', JSON.stringify(dArrL))

  // ㉗b 箭头检测器：用真实画面切片做回归（probe/fixtures/arrow-strip.png）
  //    合成贴图不行 —— 模板里大量是暗背景像素，贴出来填充率对不上。
  const { findGuideArrow } = await import('./lib/guide-arrow.mjs')
  const { decodePng } = await import('./lib/png-decode.mjs')
  const fsSync = await import('node:fs')
  const stripPos = decodePng(fsSync.readFileSync('probe/fixtures/arrow-strip.png'))
  const posHit = findGuideArrow(stripPos.rgba, stripPos.width, stripPos.height)
  ok('真实画面里的箭头 → 检测到', posHit.hit === true, JSON.stringify(posHit))
  ok('箭头方向 right', posHit.dir === 'right', JSON.stringify(posHit))
  ok('箭头横向位置 ~41%', Math.abs(posHit.x - 0.41) < 0.06, String(posHit.x))
  const stripNeg = decodePng(fsSync.readFileSync('probe/fixtures/arrow-strip-none.png'))
  ok('同一帧的无关区域 → 不误报', findGuideArrow(stripNeg.rgba, stripNeg.width, stripNeg.height).hit === false, '')
  // ㉙ 宝箱靠「持续性」确认（用户纠正：连钱符号都是蓝的，没有金色可用）
  const tk1 = createChestTracker()
  const flash = [0, 300, 600].map((ms) => tk1.feed({ chest: 3, chestX: 0.5 }, ms)).filter(Boolean)
  ok('一闪而过的蓝色（特效）不算宝箱', flash.length === 0, String(flash.length))
  const tk2 = createChestTracker()
  const persist = [0, 600, 1200, 1800, 2400].map((ms) => tk2.feed({ chest: 3, chestX: 0.5 }, ms)).filter(Boolean)
  ok('持续在同一个位置 → 确认是宝箱', persist.length > 0, String(persist.length))
  ok('确认的宝箱带横向位置', persist.length > 0 && Math.abs(persist[0].x - 0.5) < 0.05, JSON.stringify(persist[0]))
  const tk3 = createChestTracker()
  const jumpy = [0.2, 0.7, 0.35, 0.8].map((x, i) => tk3.feed({ chest: 3, chestX: x }, i * 600)).filter(Boolean)
  ok('位置乱跳的（特效）不算宝箱', jumpy.length === 0, String(jumpy.length))

  // 策略：确认宝箱后要过去开它（而不是继续乱走）
  const pChest = createPolicy('explore')
  const dChest = pChest.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, chestConfirmed: true, chestX: 0.85, chestAgeMs: 2000 }, { now: 0 })
  ok('宝箱在右侧 → 朝它走', dChest.action === 'move' && dChest.dir === 'right', JSON.stringify(dChest))
  ok('开宝箱的理由写明了', /宝箱/.test(dChest.why || ''), dChest.why)

  // 策略层：看见可破坏物就朝它走/打；看见接缝就停下观察（不瞎砍）
  const pEnvFar = createPolicy('explore')
  const dFar = pEnvFar.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 3, destructibleX: 0.8 }, { now: 0 })
  ok('可破坏物在右侧 → 走过去', dFar.action === 'move' && dFar.dir === 'right', JSON.stringify(dFar))
  const pEnvNear = createPolicy('explore')
  const dNear = pEnvNear.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 3, destructibleX: 0.5 }, { now: 0 })
  ok('可破坏物在跟前 → 打它', dNear.action === 'attack', JSON.stringify(dNear))
  ok('打可破坏物的理由说清了', /可破坏物/.test(dNear.why || ''), dNear.why)
  // 隐藏房间（宝箱都在里面）⇒ 接缝 = 入口候选，要过去试探而不是站着看
  const pSeam = createPolicy('explore')
  const dSeamFar = pSeam.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, seam: 40, seamX: 0.8 }, { now: 0 })
  ok('接缝在右侧 → 走过去', dSeamFar.action === 'move' && dSeamFar.dir === 'right', JSON.stringify(dSeamFar))
  ok('接缝的理由提到隐藏房间', /隐藏房间/.test(dSeamFar.why || ''), dSeamFar.why)
  const pSeam2 = createPolicy('explore')
  const dSeamNear = pSeam2.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, seam: 40, seamX: 0.5 }, { now: 0 })
  ok('贴到接缝 → 打一下试探暗门', dSeamNear.action === 'attack', JSON.stringify(dSeamNear))
  ok('试探的理由提到暗门', /暗门/.test(dSeamNear.why || ''), dSeamNear.why)

  // 没有可破坏物/接缝时，探索不会平白无故挥刀
  const pNoProbe = createPolicy('explore')
  let blind = 0
  for (let i = 0; i < 60; i++) {
    const d = pNoProbe.decide({ motion: 0.2, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 0, seam: 0 }, { now: i * 400 })
    if (d.action === 'attack' && /可疑/.test(d.why || '')) blind++
  }
  ok('不再有「对可疑位置盲砍」', blind === 0, String(blind))

  // ㉖ 连段：出招表来自游戏内招式表，打架时真的会打出来
  ok('连段表非空且都是合法键', COMBOS.length >= 5 && COMBOS.every((c) => /^[jilu89ws]+$/.test(c)), JSON.stringify(COMBOS))
  const pComb = createPolicy('advance')
  let sawCombo = null
  for (let i = 0; i < 40; i++) {
    const d = pComb.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 300 })
    if (d.action === 'combo') { sawCombo = d; break }
  }
  ok('打架时会打出连段', !!sawCombo, sawCombo ? JSON.stringify(sawCombo) : '40 次决策里没出现 combo')
  if (sawCombo) ok('连段带上了键序列', /^[jilu89ws]+$/.test(sawCombo.keys || ''), String(sawCombo.keys))

  // ㉒ 确认键上限：盲按 Enter 可能在菜单里选中「退出」把游戏退掉（真出过事）
  const p13 = createPolicy('advance')
  let interacts = 0
  let jumpAfterCap = false
  let others = 0
  for (let i = 0; i < 40; i++) {
    const d = p13.decide({ motion: 0.015, hudKick: 0, hudBright: 0.08, progress: 0.01 }, { now: i * 900 })
    if (d.action === 'interact') interacts++
    if (interacts >= MAX_INTERACTS && d.action === 'jump') jumpAfterCap = true
    if (['jump', 'heavy'].includes(d.action) || (d.action === 'move')) others++
  }
  ok(`确认键不超过 ${MAX_INTERACTS} 次`, interacts <= MAX_INTERACTS, String(interacts))
  ok('确认键用完后仍有其它脱困动作可用', jumpAfterCap || others > 0, `jump=${jumpAfterCap} others=${others}`)

  // ㉑ 加载/标题阶段**不能**被算成「卡住」，否则进游戏的黑屏几秒就会被判死路
  //    （2026-10-23 真机：从标题按 3 次 Enter 进游戏，加载期间 stillStreak 攒满 → 6 秒放弃）
  const p14 = createPolicy('advance')
  let stuckWhileBooting = false
  for (let i = 0; i < 10; i++) {
    const d = p14.decide({ motion: 0.001, hudKick: 0, hudBright: 0, progress: 0.0 }, { now: i * 900 })
    if (d.action === 'move' || d.action === 'heavy' || d.action === 'jump') stuckWhileBooting = true
  }
  ok('没有 HUD 时只按确认/等待，不进入脱困动作', !stuckWhileBooting, '出现了脱困动作')
  ok('没有 HUD 时 stillStreak 不累积', p14.stillStreak === 0, String(p14.stillStreak))
  ok('启动阶段的确认键上限比游戏中宽', MAX_BOOT_INTERACTS > MAX_INTERACTS, `${MAX_BOOT_INTERACTS} vs ${MAX_INTERACTS}`)
}

/* ---------- 汇总 ---------- */
console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 项通过，${fails.length} 项失败`)
if (fails.length) {
  for (const f of fails) console.log(`   - ${f}`)
  process.exit(1)
}

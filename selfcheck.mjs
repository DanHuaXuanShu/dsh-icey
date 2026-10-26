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

/* ---------- 2b. 分层（界面层 / 世界层） ---------- */
console.log('\n[2b] 分层')
{
  // 2026-10-24 拆的分层，参考 GameScaling 论文的 interface phase / world phase：
  //   界面层（lib/ui/）跨游戏通用，世界层（lib/games/icey/）每个游戏一份。
  // 规则：**单向依赖** games/ → ui/ → 无。ui/ 里出现 games/ 就是写脏了。
  const fsSync2 = await import('node:fs')
  const pathSync = await import('node:path')
  const uiDir = 'lib/ui'
  const uiFiles = fsSync2.existsSync(uiDir)
    ? fsSync2.readdirSync(uiDir).filter((f) => f.endsWith('.mjs'))
    : []
  ok('界面层目录存在且有文件', uiFiles.length >= 3, String(uiFiles.length))
  const leaks = []
  for (const f of uiFiles) {
    const src = fsSync2.readFileSync(pathSync.join(uiDir, f), 'utf8')
    // 只查 import 语句里的路径，不查注释里提到的文字
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      if (m[1].includes('games/') || m[1].includes('../games')) leaks.push(`${f} → ${m[1]}`)
    }
  }
  ok('界面层不依赖任何具体游戏（单向依赖）', leaks.length === 0, leaks.join(', ') || '干净')
  ok('ICEY 的画面布局在世界层里', fsSync2.existsSync('lib/games/icey/layout.mjs'), '')

  // scan.mjs 必须真的「不含坐标」：拿一组不同的区域传进去都得能算
  const { regionStats } = await import('./lib/ui/scan.mjs')
  const fake = Buffer.alloc(64 * 48 * 4, 200)
  const a = regionStats(fake, 64, 48, { x0: 0, y0: 0, x1: 1, y1: 1 }, { lumMin: 150 })
  const b = regionStats(fake, 64, 48, { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.6 }, { lumMin: 150 })
  ok('区域统计接受任意坐标（不是写死 ICEY 的）', a.count > 0 && b.count > 0 && a.count !== b.count, `${a.count}/${b.count}`)
  ok('全亮画面：亮像素占比 = 1', Math.abs(a.brightRatio - 1) < 1e-9, String(a.brightRatio))
}

/* ---------- 2c. 事件层 ---------- */
console.log('\n[2c] 事件层')
{
  // 为什么要有这一层：连玩时插件每秒转十几圈，模型一次决策要几秒。
  // 要让模型「几秒钟的思考」影响插件「接下来几十秒的行为」，前提是插件把
  // 发生了什么说清楚——带类型、带等级、能去重、能跨回合存。
  const { EventLog, KINDS, LEVELS } = await import('./lib/events.mjs')

  ok('事件 kind 是一份明确清单（不是散字符串）', Array.isArray(KINDS) && KINDS.length >= 8, String(KINDS.length))
  ok('等级分三档 info/notable/urgent', LEVELS.length === 3 && LEVELS[0] === 'info', LEVELS.join('/'))

  const log = new EventLog({ limit: 50 })
  log.push('fight-start', 'notable', '第 4s 进入战斗', {}, 4)
  log.push('damage', 'notable', '第 5s 掉血 8%', { to: 0.64 }, 5, 0.08)
  log.push('damage', 'notable', '第 5.5s 掉血 10%', { to: 0.62 }, 5.5, 0.10)
  ok('同类事件在去重窗口内合并成一条', log.length === 2, String(log.length))
  ok('合并时更严重的那次替换文案和数值', log.items[1].repeat === 1 && log.items[1].data.to === 0.62, JSON.stringify(log.items[1]))

  // 实战踩过的坑：12%（notable）→ 23%（urgent）→ 12%（notable）合并后，
  // 曾出现「[urgent] 跌 12%」——等级和文案对不上，会骗模型。
  log.push('damage', 'notable', '第 5.8s 掉血 9%', { to: 0.63 }, 5.8, 0.09)
  ok('不够严重的不改写摘要文案（只加重复计数）',
    log.items[1].data.to === 0.62 && log.items[1].repeat === 2, JSON.stringify(log.items[1]))

  const mixed = new EventLog()
  mixed.push('damage', 'notable', '跌 12%', { drop: 0.12 }, 7, 0.12)
  mixed.push('damage', 'urgent', '跌 23%', { drop: 0.23 }, 9, 0.23)
  mixed.push('damage', 'notable', '跌 12%', { drop: 0.12 }, 11, 0.12)
  ok('合并后等级和文案一致（不会出现 urgent 顶着 12%）',
    mixed.items[0].level === 'urgent' && mixed.items[0].text.includes('23'), JSON.stringify(mixed.items[0]?.text))

  log.push('damage', 'notable', '第 9s 掉血 8%', { to: 0.60 }, 9, 0.08)
  ok('超过去重窗口后算新的一条', log.count('damage') === 2, String(log.count('damage')))

  const order = new EventLog()
  order.push('scene', 'info', '第 20s 画面剧变', {}, 20)
  order.push('blocked', 'urgent', '第 18s 这处过不去', {}, 18)
  order.push('chest', 'notable', '第 6s 确认到宝箱', {}, 6)
  const dg = order.digest({ minLevel: 'info' })
  ok('摘要按 urgent → notable → info 排（不是按时间）',
    dg.indexOf('[urgent]') === 0 &&
    dg.indexOf('[notable]') > dg.indexOf('[urgent]') &&
    dg.indexOf('[info]') > dg.indexOf('[notable]'),
    dg.split('\n')[0])
  ok('摘要能按等级过滤（只给 notable 以上）',
    !order.digest({ minLevel: 'notable' }).includes('[info]'), '')

  const capped = new EventLog({ limit: 4 })
  capped.push('blocked', 'urgent', '第 1s 卡死', {}, 1)
  for (let i = 2; i <= 8; i++) capped.push('scene', 'info', `第 ${i}s 画面剧变`, {}, i)
  ok('超限时优先丢 info、urgent 留着',
    capped.length <= 4 && capped.items.some((e) => e.level === 'urgent'), String(capped.length))

  const bad = new EventLog()
  const unknown = bad.push('not-a-real-kind', 'weird-level', '测试未知事件')
  ok('未知 kind / 等级不崩，降级成 info', bad.length === 1 && unknown.level === 'info', JSON.stringify(unknown))

  const round = EventLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())))
  ok('toJSON/fromJSON 往返不丢条目',
    round.length === log.length && round.count('damage') === log.count('damage'), `${round.length}/${log.length}`)
  ok('fromJSON 遇到坏数据不抛',
    EventLog.fromJSON(null).length === 0 && EventLog.fromJSON({ items: 'x' }).length === 0, '')
}

/* ---------- 2d. 跨回合记忆 ---------- */
console.log('\n[2d] 跨回合记忆')
{
  // 为什么要有：icey_play 是独立工具调用，模型每次都是「第一次看这个世界」，
  // 不给它上一轮的记忆，它会重复上一轮犯的错。
  // ⚠️ 这个测试必须用临时 DSH_HOME，绝不能写真实的 ~/.dsh/icey/last-runs.json。
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmpHome = mkdtempSync(join(tmpdir(), 'icey-hist-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmpHome
  try {
    const h = await import('./lib/run-history.mjs')
    ok('存档路径落在 DSH_HOME 下', h.historyPath().startsWith(tmpHome), h.historyPath())
    ok('没有存档时返回 null 而不是崩', h.previousRun() === null && h.loadRuns().length === 0, '')

    h.saveRun({ at: '2026-10-24T10:00:00Z', seconds: 30, preset: 'advance', stopped: '玩满 30 秒', eventDigest: '[notable] 第 4s 进入战斗' })
    h.saveRun({ at: '2026-10-24T10:01:00Z', seconds: 20, preset: 'fight', stopped: '打不过', eventDigest: '[urgent] 第 9s 卡死' })
    ok('存一轮能读回来', h.loadRuns().length === 2, String(h.loadRuns().length))
    ok('previousRun 是最后存的那轮', h.previousRun()?.preset === 'fight', JSON.stringify(h.previousRun()?.preset))

    for (let i = 0; i < 4; i++) h.saveRun({ at: `2026-10-24T11:0${i}:00Z`, seconds: 10, preset: 'advance' })
    ok('只留最近 3 轮（老的不无限堆积）', h.loadRuns().length === 3, String(h.loadRuns().length))

    const desc = h.describeRun(h.previousRun())
    ok('能压成一行文字给模型看', desc.length > 0 && desc.includes('advance'), desc)

    writeFileSync(h.historyPath(), '{ 这不是 JSON', 'utf8')
    ok('存档被写坏时不崩、当空的处理', h.loadRuns().length === 0 && h.previousRun() === null, '')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

/* ---------- 2e. 隐藏房间指纹 ---------- */
console.log('\n[2e] 隐藏房间指纹')
{
  // 为什么有这个：这种房间里宝箱**时灵时不灵**（符号被粗光带打白就退出青色掩码）。
  // 与其要求单帧认出来，不如先认出房间。实测两张真图：低饱和 0.34%/0.41%、高饱和青 6.79%/7.04%。
  const { analyzeEnvironment, GRID_ROOM_LOW_SAT_MAX, GRID_ROOM_CYAN_MIN } = await import('./lib/autoplay.mjs')
  const W = 160, H = 120
  const mk = (fill) => {
    const buf = Buffer.alloc(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = fill(x, y)
        const i = (y * W + x) * 4
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255
      }
    }
    return buf
  }

  // 隐藏房间：暗底 + 密集青色网格线
  const room = mk((x, y) => (x % 6 === 0 || y % 6 === 0 ? [30, 190, 240] : [8, 20, 30]))
  const roomEnv = analyzeEnvironment(room, W, H)
  ok('满屏青色网格 → 判定为隐藏房间', roomEnv.gridRoom === true, `低饱和 ${roomEnv.lowSatRatio} 青 ${roomEnv.cyanRatio}`)
  ok('隐藏房间的低饱和占比确实很低', roomEnv.lowSatRatio < GRID_ROOM_LOW_SAT_MAX, String(roomEnv.lowSatRatio))
  ok('隐藏房间的高饱和青确实很宽', roomEnv.cyanRatio > GRID_ROOM_CYAN_MIN, String(roomEnv.cyanRatio))

  // 普通场景：大量灰白（地面/墙/角色皮肤）+ 一些彩色，低饱和占比高
  const normal = mk((x, y) => ((x + y) % 3 === 0 ? [200, 195, 185] : [70, 60, 55]))
  const normalEnv = analyzeEnvironment(normal, W, H)
  ok('普通灰白场景不会被误判成隐藏房间', normalEnv.gridRoom === false, `低饱和 ${normalEnv.lowSatRatio} 青 ${normalEnv.cyanRatio}`)

  // 反例：只有青色、没有暗部 → 低饱和依然低，但这是"纯青色画面"不是房间；
  // 这里只保证判据不会因为缺字段崩掉，不额外要求它拒绝（房间本来就该认）。
  ok('指纹字段始终是数字，不缺字段', typeof roomEnv.lowSatRatio === 'number' && typeof roomEnv.cyanRatio === 'number', '')
}

/* ---------- 2f. 游戏无响应检测 ---------- */
console.log('\n[2f] 游戏无响应检测')
{
  // 来龙去脉：2026-10-24 连玩时游戏卡死，Enter×4 / Esc / Q 全被吞，
  // 五次操作截图 SHA 完全一致，而插件还在报「在前台、可以操作」。
  // 判据：画面一个像素都不变 + 这期间我们按过键 ⇒ 不是卡住，是游戏死了。
  const { frameHash, createFreezeDetector, FREEZE_FRAMES } = await import('./lib/ui/frame-print.mjs')
  const W = 64, H = 48
  const mkFrame = (seed = 0) => {
    const b = Buffer.alloc(W * H * 4)
    for (let i = 0; i < b.length; i++) b[i] = (i * 7 + seed) & 0xff
    return b
  }
  const a = mkFrame(0)
  const aCopy = mkFrame(0)
  const b = mkFrame(1)

  ok('同一帧两次哈希相等', frameHash(a, W, H) === frameHash(aCopy, W, H), '')
  ok('换一帧哈希就变', frameHash(a, W, H) !== frameHash(b, W, H), '')
  ok('尺寸不同则哈希不同', frameHash(a, W, H) !== frameHash(a, W, H + 1), '')

  // 场景 1：画面完全静止 + 期间一直按键 → 判死
  {
    const fd = createFreezeDetector()
    for (let i = 0; i < FREEZE_FRAMES; i++) fd.feed(a, W, H, { acted: true })
    ok('静态画面 + 一直在按键 → 判定游戏无响应', fd.frozen === true, `streak=${fd.streak}`)
  }
  // 场景 2：画面静止但没按键（我们自己按 Esc 暂停就是这样）→ 不误判
  {
    const fd = createFreezeDetector()
    for (let i = 0; i < FREEZE_FRAMES * 2; i++) fd.feed(a, W, H, { acted: false })
    ok('静态画面但没按键（正常暂停）→ 不误判', fd.frozen === false, `streak=${fd.streak}`)
  }
  // 场景 3：画面一直在动 → 不误判
  {
    const fd = createFreezeDetector()
    for (let i = 0; i < FREEZE_FRAMES * 2; i++) fd.feed(mkFrame(i), W, H, { acted: true })
    ok('画面一直在变 → 不误判', fd.frozen === false, `streak=${fd.streak}`)
  }
  // 场景 4：中途动一下，计数从头算（新画面自己就算「连续 1 帧」）
  {
    const fd = createFreezeDetector()
    for (let i = 0; i < FREEZE_FRAMES - 1; i++) fd.feed(a, W, H, { acted: true })
    fd.feed(b, W, H, { acted: true })
    ok('画面一变就把计数重置为 1', fd.streak === 1, `streak=${fd.streak}`)
  }
  ok('冻结阈值是个合理的秒数（1 帧≈0.7s）', FREEZE_FRAMES >= 4 && FREEZE_FRAMES <= 12, String(FREEZE_FRAMES))
}

/* ---------- 2g. 批量动作简写解析 ---------- */
console.log('\n[2g] 批量动作简写解析')
{
  // 一次 icey_act 要付一次模型往返（6~12 秒），所以支持 sequence 一次走一串。
  // 这里验证「写的简写」和「planAction 吃的 input」对得上——
  // 解析器返回的东西必须能直接喂 planAction，否则批量模式到执行那一步才炸。
  const { parseActionSpec, planAction, MAX_SEQUENCE } = await import('./lib/control.mjs')
  const cases = [
    ['jjji', { action: 'combo', keys: 'jjji' }],
    ['jjj|s+j', { action: 'combo', keys: 'jjj|s+j' }],
    ['move:right:400', { action: 'move', dir: 'right', ms: 400 }],
    ['dash:up:200', { action: 'dash', dir: 'up', ms: 200 }],
    ['chase:left:260', { action: 'chase', dir: 'left', ms: 260 }],
    ['combo:jjiii', { action: 'combo', keys: 'jjiii' }],
    ['menu:resume', { action: 'menu', item: 'resume' }],
    ['jump', { action: 'jump' }],
    ['wait:300', { action: 'wait', ms: 300 }],
  ]
  for (const [spec, want] of cases) {
    eq(`解析 ${spec}`, parseActionSpec(spec), want)
  }

  // 解析出来的每一项都必须能被 planAction 接受。
  // ⚠️ wait 是**例外**：它不按键，由 agent.js 的批量层直接 sleep，不进 planAction。
  //    2026-10-24 这里曾经写成 `if (input.action === 'wait') continue` 悄悄跳过，
  //    结果真机上 `wait:300` 报「动作不认识：wait」——测试自己骗了自己。
  //    现在把「跳过」这件事显式断言出来，不再默默绕过。
  let unplannable = []
  let waitSkipped = 0
  for (const [spec] of cases) {
    const input = parseActionSpec(spec)
    if (!input) continue
    if (input.action === 'wait') { waitSkipped++; continue }
    try { planAction(input) } catch (e) { unplannable.push(`${spec}: ${e.message}`) }
  }
  ok('每个按键简写都能直接喂给 planAction', unplannable.length === 0, unplannable.join(' | '))
  ok('wait 是特殊项：不经过 planAction（批量层自己 sleep）',
    waitSkipped === 1 && parseActionSpec('wait:300').action === 'wait', `skipped=${waitSkipped}`)

  // 无效写法必须返回 null，不能猜
  for (const bad of ['', '   ', 'nonsense', 'move:', 'dash:', 'teleport:up', '1234567890x']) {
    ok(`无效写法 ${JSON.stringify(bad)} 返回 null`, parseActionSpec(bad) === null, String(parseActionSpec(bad)))
  }
  ok('sequence 有上限（防手滑写一大串）', MAX_SEQUENCE > 0 && MAX_SEQUENCE <= 20, String(MAX_SEQUENCE))
}

/* ---------- 2h. 战斗屏障 ---------- */
console.log('\n[2h] 战斗屏障')
{
  // 2026-10-24 用户说明的机制：战斗时场景**两端**升起能量墙，清完敌人才消失。
  // 它是「这场仗还没打完」最硬的证据 —— 敌人倒地不动、HUD 不跳时只有它还亮着。
  // 不加这条，插件会以为打完了 → 往前走 → 撞墙 → 判死路 → 掉头。
  const mod = await import('./lib/autoplay.mjs')
  const { analyzeEnvironment, createPolicy } = mod
  const W = 240, H = 180
  const wallW = 24   // 约画面 10%，比两列网格宽一点，确保被算进边缘列

  const mk = (side) => {
    const buf = Buffer.alloc(W * H * 4, 30)   // 暗底
    const paint = (x0, x1) => {
      for (let y = 0; y < H; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          buf[i] = 110; buf[i + 1] = 230; buf[i + 2] = 255   // 青白发光
        }
      }
    }
    if (side === 'left' || side === 'both') paint(0, wallW)
    if (side === 'right' || side === 'both') paint(W - wallW, W)
    return buf
  }

  const none = analyzeEnvironment(mk('none'), W, H)
  const left = analyzeEnvironment(mk('left'), W, H)
  const right = analyzeEnvironment(mk('right'), W, H)
  const both = analyzeEnvironment(mk('both'), W, H)

  ok('没有屏障 → barrier=false', none.barrier === false, `edge=${none.barrierEdge}`)
  ok('左边有屏障 → 检出', left.barrier === true && left.barrierLeft === true, `L=${left.barrierLeft} edge=${left.barrierEdge}`)
  ok('右边有屏障 → 检出', right.barrier === true && right.barrierRight === true, `R=${right.barrierRight} edge=${right.barrierEdge}`)
  ok('两端都有 → 检出', both.barrier === true, `edge=${both.barrierEdge}`)

  // 最关键的一条：屏障亮着时，即使画面完全不动，也不能判「这条路走不通」去掉头。
  const pBar = createPolicy('advance')
  const dB = pBar.decide({ motion: 0, hudKick: 0, progress: 0, barrier: true }, { now: 0 })
  ok('屏障亮 + 画面不动 → 不判死路掉头', !/掉头/.test(dB.why || ''), JSON.stringify(dB))

  // 对照：没有屏障时，同样的「画面不动」应该进脱困阶梯（说明上面的差异确实来自 barrier）
  const pNo = createPolicy('advance')
  const dN = pNo.decide({ motion: 0, hudKick: 0, progress: 0, barrier: false }, { now: 0 })
  const looksStuck = /反向挪|跳一下|掉头|画面几乎不动/.test(dN.why || '')
  ok('对照：没屏障时画面不动 → 会进脱困处理', looksStuck, JSON.stringify(dN))
}

/* ---------- 3. 控制映射 ---------- */
console.log('\n[3] 控制映射')
{
  const { DEFAULT_KEYMAP, planAction, ACTION_SPECS } = await import('./lib/control.mjs')
  ok('默认键位与 ICEY 一致', DEFAULT_KEYMAP.moveLeft === 'a' && DEFAULT_KEYMAP.moveRight === 'd' &&
    DEFAULT_KEYMAP.moveUp === 'w' && DEFAULT_KEYMAP.moveDown === 's' &&
    DEFAULT_KEYMAP.attack === 'j' && DEFAULT_KEYMAP.jump === ' ' &&
    DEFAULT_KEYMAP.heavy === 'i' && DEFAULT_KEYMAP.execute === 'l' &&
    DEFAULT_KEYMAP.dash === 'o' && DEFAULT_KEYMAP.chase === 'u' &&
    DEFAULT_KEYMAP.yes === 'q' && DEFAULT_KEYMAP.no === 'e',
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
  // 🔴 回归：2026-10-24 发现 dash 以前**只返回方向键、从来没按过 O**，
  //    所以所有「闪避/冲刺」实际只是往那个方向走 180ms。这条断言就是钉死这个的。
  eq('dash left → 按住 a 再点 o（冲刺是两步，不能只按方向）', dash.steps.map((s) => s.key), ['a', DEFAULT_KEYMAP.dash])
  ok('dash 里有冲刺键（防止再退回「只按方向」）', dash.steps.some((s) => s.key === DEFAULT_KEYMAP.dash), JSON.stringify(dash.steps.map((s) => s.key)))
  // 垂直方向：够空中的入口用。PC 版冲刺是四方向的（FlashUp），以前从没调用过 up。
  const dashUp = planAction({ action: 'dash', dir: 'up' })
  eq('dash up → 按住 w 再点 o', dashUp.steps.map((s) => s.key), [DEFAULT_KEYMAP.moveUp, DEFAULT_KEYMAP.dash])

  // 元游戏对话框的两个选项键（2026-10-25）。旁白会突然问「您是否是丹华玄书」，
  // 画面上「否」和「E.」就是这两个键 —— 没有它们插件只能按 Enter 对着故障画面打转。
  // 两个特殊技（湍流 键8 / 流场 键9）权重必须压低（2026-10-25 用户要求）。
  // 它们消耗生命换免疫，性价比不如连段和重击。原来各 1/25 ≈ 4%，另有「每 37/41 循环必放一次」
  // 的定时触发叠加，实际出场频率更高。
  {
    const { ACTION_WEIGHTS } = await import('./lib/autoplay.mjs')
    const fw = ACTION_WEIGHTS.fight
    ok(
      '两个特殊技权重压到 1 以下（低于普攻和重击）',
      fw.storm < 1 && fw.shade < 1 && fw.storm < fw.attack && fw.shade < fw.attack,
      JSON.stringify(fw),
    )
  }

  // ── 场景分类 + 卡住检测（2026-10-26）──────────────────────────────
  // 这一层解决的是「没有对应分支的局面」—— 以前遇到剧情锁、商店、需要解谜的门，
  // decide() 只会掉进默认的「继续往右走」，然后一次次撞同一面墙。
  {
    const { classifyScene, StuckDetector, STUCK_MS } = await import('./lib/games/icey/scene.mjs')

    // 1. 菜单优先于一切
    ok('场景：有红色警告文字行 → menu',
      classifyScene({ menuRows: 1, combo: 0.03, hud: 0.5 }).scene === 'menu',
      JSON.stringify(classifyScene({ menuRows: 1, combo: 0.03, hud: 0.5 })))

    // 2. 连击数在涨 → combat（哪怕同时有字幕，也该打不该读字）
    ok('场景：连击数在涨 → combat',
      classifyScene({ menuRows: 0, combo: 0.03, subtitle: 0.01, hud: 0.5 }).scene === 'combat')
    ok('场景：战斗屏障亮着 → combat',
      classifyScene({ menuRows: 0, combo: 0, barrier: true, hud: 0.5 }).scene === 'combat')

    // 3. 旁白在说话
    ok('场景：下方白字 → dialog',
      classifyScene({ menuRows: 0, combo: 0, subtitle: 0.01, hud: 0.5 }).scene === 'dialog')

    // 4. 黑屏（过场/加载/标题）
    ok('场景：HUD 区几乎全暗 → blank',
      classifyScene({ menuRows: 0, combo: 0, subtitle: 0, hud: 0.005 }).scene === 'blank')

    // 5. 黑屏 + 字幕 ⇒ 按 dialog 处理（过场字幕要按确认跳过，不是干等）
    ok('场景：黑屏但有字幕 → dialog（不是 blank）',
      classifyScene({ menuRows: 0, combo: 0, subtitle: 0.01, hud: 0.005 }).scene === 'dialog')

    // 6. 卡住标记
    ok('场景：外部标记卡住 → stuck',
      classifyScene({ menuRows: 0, combo: 0, subtitle: 0, hud: 0.5 }, { stuck: true, stuckMs: 60000 }).scene === 'stuck')

    // 7. 默认正常
    ok('场景：有 HUD、没打、没说话 → explore',
      classifyScene({ menuRows: 0, combo: 0, subtitle: 0, hud: 0.5 }).scene === 'explore')

    // 8. 卡住检测：画面一直不变，超过阈值 → 卡住
    {
      const d = new StuckDetector({ stuckMs: STUCK_MS })
      const frame = { subtitle: 0.001, hud: 0.5, combo: 0 }
      let t = 0
      d.update('explore', frame, t)          // 第一次，建立基线
      let stuck = false
      for (t = 1000; t <= STUCK_MS + 5000; t += 1000) {
        stuck = d.update('explore', frame, t)
      }
      ok('卡住检测：画面长期不变 → 判卡住', stuck === true, `t=${t}`)
    }

    // 9. 卡住检测：中间有进展（字幕变了）→ 不算卡住
    {
      const d = new StuckDetector({ stuckMs: STUCK_MS })
      let t = 0
      d.update('explore', { subtitle: 0.001, hud: 0.5 }, t)
      let stuck = false
      for (t = 1000; t <= STUCK_MS + 5000; t += 1000) {
        // 每 10 秒换一次字幕（模拟剧情推进）
        const sub = (t % 10000 === 0 && t > 0) ? (t % 20000 === 0 ? 0.05 : 0.001) : undefined
        stuck = d.update('explore', { subtitle: sub ?? d.lastSubtitle, hud: 0.5 }, t)
      }
      ok('卡住检测：字幕在变 → 不算卡住', stuck === false, `t=${t}`)
    }

    // 10. 卡住检测：场景标签变化也算进展
    {
      const d = new StuckDetector({ stuckMs: STUCK_MS })
      let t = 0
      d.update('explore', { subtitle: 0.001, hud: 0.5 }, t)
      let stuck = false
      const seq = ['explore', 'combat', 'explore', 'combat', 'explore']
      let i = 0
      for (t = 1000; t <= STUCK_MS + 5000; t += 1000) {
        stuck = d.update(seq[i % seq.length], { subtitle: 0.001, hud: 0.5 }, t)
        i++
      }
      ok('卡住检测：场景标签在变 → 不算卡住', stuck === false, `t=${t}`)
    }
  }

  const dYes = planAction({ action: 'yes' }, { keyMap: DEFAULT_KEYMAP })
  const dNo = planAction({ action: 'no' }, { keyMap: DEFAULT_KEYMAP })
  eq('对话框选「是」→ 点 q', dYes.steps.map((s) => s.key), ['q'])
  eq('对话框选「否」→ 点 e', dNo.steps.map((s) => s.key), ['e'])
  ok('对话框两个字都写清了是选哪个', /选「是」/.test(dYes.desc || '') && /选「否」/.test(dNo.desc || ''), dYes.desc + ' / ' + dNo.desc)
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
  const { analyzeFrame, createPolicy, PRESETS, summarizeRun, STILL_MOTION, FIGHT_HUDKICK, PRESENCE_BRIGHT, PROGRESS_MIN, UNSTUCK_LADDER, MAX_INTERACTS, MAX_BOOT_INTERACTS, PROMPT_MIN, ACTION_WEIGHTS, SUBTITLE_MIN, pickWeighted, COMBOS, COMBO_WEIGHTS, analyzeEnvironment, DESTRUCT_SAT, SEAM_DIFF, VFX_DANGER, createChestTracker, MENU_LIST_BANDS, MENU_DARK_RATIO, FIGHT_MOTION, FIGHT_ACTIVE_RATIO } = await import('./lib/autoplay.mjs')

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
  // 第 2 下是**跳**（2026-10-24 起阶梯里不再有 Enter —— 看不见提示框时按它只可能打开菜单）
  const d2 = p1.decide({ motion: 0, hudKick: 0 }, { now: 2000 })
  ok('静止第 2 次 → 跳（阶梯里没有 Enter）', d2.action === 'jump', JSON.stringify(d2))
  // 第 3 下是**跳 + 空中上冲**（2026-10-24 实测：地面直接按 W+O 只会朝右冲，必须先跳）
  const dStuck3 = p1.decide({ motion: 0, hudKick: 0 }, { now: 2400 })
  ok('静止第 3 次 → 跳 + 空中上冲',
    dStuck3.action === 'combo' && dStuck3.keys === 'k|w+o',
    JSON.stringify(dStuck3))
  // 第 4 下才认输掉头（阶梯是「退一步 → 跳 → 跳+上冲」三步无损试探）
  const dStuck4 = p1.decide({ motion: 0, hudKick: 0 }, { now: 2800 })
  ok('静止第 4 次 → 掉头（三步试探都没用就认输）', dStuck4.action === 'move' && /掉头/.test(dStuck4.why || ''), JSON.stringify(dStuck4))
  ok('脱困时不挥刀（别盲砍可疑位置）', !/^(heavy|attack)$/.test(dStuck4.action), String(dStuck4.action))
  ok('Enter 有节流（刚按过不会连点）', p1.decide({ motion: 0, hudKick: 0 }, { now: 2500 }).action !== 'interact', 'throttled')

  // ⑥ 策略：HUD 在跳 → 打架，出攻击/重击
  const p2 = createPolicy('advance')
  const fightMoves = []
  for (let i = 0; i < 6; i++) fightMoves.push(p2.decide({ motion: 0.3, combo: 1, hudKick: FIGHT_HUDKICK + 0.05 }, { now: i * 100 }))
  ok('在打架时只出战斗动作（含闪避/位移）', fightMoves.every((d) => ['attack', 'heavy', 'dash', 'move', 'jump', 'chase', 'execute', 'storm', 'shade', 'combo'].includes(d.action)), fightMoves.map((d) => d.action).join(','))
  ok('在打架时确实会攻击（含连段）', fightMoves.some((d) => d.action === 'attack' || d.action === 'combo' || d.action === 'heavy'), fightMoves.map((d) => d.action).join(','))

  // ⑥b 只有 HUD 大跳、画面不动 → 这是 UI 切换（菜单开合/场景切换），不是战斗。
  //     2026-10-25 之前 hudKick 参与战斗判据，实测「暂停菜单一关」就会被当成「进入战斗」。
  const pUi = createPolicy('advance')
  const uiMoves = Array.from({ length: 6 }, (_, i) => pUi.decide({ motion: 0.01, hudKick: FIGHT_HUDKICK + 0.05, hudBright: 0.08 }, { now: i * 100 }).action)
  ok('HUD 大跳但画面静止 → 不判战斗（不空挥刀）', !uiMoves.some((a) => ['attack', 'heavy', 'combo', 'storm', 'shade'].includes(a)), uiMoves.join(','))

  // ⑥c 原地放技能（motion 10–13%）→ 不判战斗。2026-10-25 用用户录屏 300 帧复核出来的：
  //     帧 108-111 是艾希在原地放技能、场上没有敌人，motion 只有 10-13%；
  //     真战斗（帧 294-297）是 25-46%，中间是空的。所以 FIGHT_MOTION 从 8% 抬到了 15%。
  const pSkill = createPolicy('advance')
  const skillMoves = Array.from({ length: 8 }, (_, i) => pSkill.decide({ motion: 0.12, hudKick: 0, hudBright: 0.05, progress: 0.5 }, { now: i * 700 }).action)
  ok('原地放技能（motion 12%）→ 不判战斗', !skillMoves.some((a) => ['attack', 'heavy', 'combo', 'storm', 'shade'].includes(a)), skillMoves.join(','))

  // ⑥d 黑屏过场（压暗 95%，但 HUD 一起没了）→ 不是菜单，不许按 Esc。
  //     2026-10-25 实机抓到这条循环：黑屏被判成菜单 → 按 Esc 想退出 →
  //     游戏里 Esc 就是「打开」暂停菜单 → 于是真的被按出来了，然后卡在菜单里出不去。
  //     用户早就记过一条「菜单会自己打开」，真相是插件自己按的。
  const pDark = createPolicy('advance')
  const darkMoves = Array.from({ length: 6 }, (_, i) => pDark.decide({ motion: 0.01, hudKick: 0, hudBright: 0, darkRatio: 0.95, listBands: 2, progress: 0.5 }, { now: i * 700 }).action)
  ok('黑屏过场（压暗但没 HUD）→ 不按 Esc', !darkMoves.includes('pause'), darkMoves.join(','))

  // ⑥e 真菜单（压暗但血条还亮着）→ 仍然按 Esc 退出。这条别被上面修坏了
  const pMenuDark = createPolicy('advance')
  const menuDarkMoves = Array.from({ length: 4 }, (_, i) => pMenuDark.decide({ motion: 0.01, hudKick: 0, hudBright: 0, darkRatio: 0.95, listBands: 10, menuRows: 1, progress: 0.5 }, { now: i * 700 }).action)
  ok('真菜单（压暗但血条还在）→ 按 Esc 退出', menuDarkMoves.includes('pause'), menuDarkMoves.join(','))

  // ⑥f 明亮场景里物体边缘也会被数成「文字条带」——但压暗只有 11%，不是菜单。
  //     2026-10-25 实机撞到：listBands=9~10 / darkRatio=0.11，被当成菜单按了 Esc。
  const pBright = createPolicy('advance')
  const brightMoves = Array.from({ length: 4 }, (_, i) => pBright.decide({ motion: 0.01, hudKick: 0, hudBright: 0.06, darkRatio: 0.11, listBands: 10, progress: 0.5 }, { now: i * 700 }).action)
  ok('明亮场景（条带多但不暗）→ 不按 Esc', !brightMoves.includes('pause'), brightMoves.join(','))

  // ⑥g 菜单靠「红色文字行」判：菜单里那行固定红字是唯一分得开的证据。
  //     实测 菜单 1 条 / 普通画面 0 条 / 战斗红特效 0 条。
  const pRed = createPolicy('advance')
  const redMoves = Array.from({ length: 3 }, (_, i) => pRed.decide({ motion: 0.01, hudKick: 0, hudBright: 0, darkRatio: 0.92, listBands: 2, menuRows: 1, progress: 0.5 }, { now: i * 700 }).action)
  ok('菜单红字（1 条红色文字行）→ 按 Esc 退出', redMoves.includes('pause'), redMoves.join(','))

  const pNoRed = createPolicy('advance')
  const noRedMoves = Array.from({ length: 3 }, (_, i) => pNoRed.decide({ motion: 0.01, hudKick: 0, hudBright: 0.06, darkRatio: 0.11, listBands: 10, menuRows: 0, progress: 0.5 }, { now: i * 700 }).action)
  ok('没有红字（战斗/明亮场景）→ 不按 Esc', !noRedMoves.includes('pause'), noRedMoves.join(','))

  // ⑥g2 「红色文字行」必须能跨分析宽度成立，而且不能把块状红特效当成文字。
  //      2026-10-26 实测的两个真 bug：
  //        ① 真菜单警告行在 1280 下 11 行高，缩到 480 只剩 3 行，被 minBandHeight=5 整个滤掉
  //           ⇒ 默认配置(analysisWidth=480)下暂停菜单根本认不出来。
  //        ② 480 下的红色霓虹窗/伤害火花能过旧判据 ⇒ 593 张战斗帧里 28 帧被判成菜单、按了 22 次 Esc。
  //      判据分界：文字是细笔画（平均横向游程 ~1.5px），特效是块状（≥3px）。
  {
    const { findRedTextRows } = await import('./lib/ui/scan.mjs')
    const mk = (w, h) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < a.length; i += 4) { a[i] = 20; a[i + 1] = 20; a[i + 2] = 22; a[i + 3] = 255 } return a }
    const paint = (a, w, x, y, rgb) => { const i = (y * w + x) * 4; a[i] = rgb[0]; a[i + 1] = rgb[1]; a[i + 2] = rgb[2]; a[i + 3] = 255 }

    // 文字：3 行高、每行一根根 1px 细竖笔画（模拟中文笔画）
    const w1 = 480, h1 = 280, text = mk(w1, h1)
    for (let y = 100; y <= 102; y++) for (let x = 70; x < 182; x += 2) paint(text, w1, x, y, [200, 60, 60])
    const textBands = findRedTextRows(text, w1, h1)
    ok('细笔画红字（3 行高的警告行）在 480 宽下也认得出', textBands.length === 1, `bands=${textBands.length}`)

    // 特效：同一位置改成几块大色斑（每块 18px 宽、10 行高）
    const vfx = mk(w1, h1)
    for (const x0 of [70, 120, 160]) for (let y = 96; y <= 105; y++) for (let x = x0; x < x0 + 18; x++) paint(vfx, w1, x, y, [200, 60, 60])
    const vfxBands = findRedTextRows(vfx, w1, h1)
    ok('块状红特效（伤害火花/霓虹）不当成红色文字行', vfxBands.length === 0, `bands=${vfxBands.length}`)

    // 同一张文字帧放到 640 宽也要认得出（门槛按分辨率折算，不是写死 5 行）
    const w2 = 640, h2 = 373, text2 = mk(w2, h2)
    for (let y = 132; y <= 136; y++) for (let x = 94; x < 242; x += 3) paint(text2, w2, x, y, [200, 60, 60])
    const text2Bands = findRedTextRows(text2, w2, h2)
    ok('同样的红字换到 640 宽也认得出', text2Bands.length === 1, `bands=${text2Bands.length}`)
  }

  // ⑥h 掉血 = 真在挨打 → 判战斗。
  //     2026-10-25 实机：150 秒里 damage×23，可 fight-start 只认了 1 次 —— 连击会因超时/破盾断开，
  //     光靠它漏得厉害。用户说明：一段时间没打到敌人就断，护盾破了之后受击也断。
  const pDmg = createPolicy('advance')
  pDmg.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, combo: 0, menuRows: 0, progress: 0.5 }, { now: 0 })
  const dmgMoves = []
  for (let i = 1; i <= 4; i++) {
    dmgMoves.push(pDmg.decide({ motion: 0.01, hudKick: 0, hudBright: 0.07, combo: 0, menuRows: 0, progress: 0.5 }, { now: i * 300 }).action)
  }
  ok('掉血（血条变短）→ 判战斗', dmgMoves.some((a) => ['attack', 'heavy', 'combo', 'storm', 'shade', 'chase'].includes(a)), dmgMoves.join(','))

  // ⑦ 策略：正常推进 → 走右
  const p3 = createPolicy('advance')
  const d3 = p3.decide({ motion: 0.01, hudKick: 0 }, { now: 0 })
  ok('正常情况会往右推进', d3.action === 'move' && d3.dir === 'right', JSON.stringify(d3))

  // ⑧ 确定性：同样的输入序列 → 同样的动作序列（所以能离线单测）
  const runSeq = (preset) => {
    const p = createPolicy(preset)
    return [0, 1, 2, 3, 4, 5].map((i) => p.decide({ motion: 0.01, hudKick: 0 }, { now: i * 100 }).action).join(',')
  }
  eq('策略是确定性的', runSeq('advance'), runSeq('advance'))

  // ⑨ 三个预设都能出动作，且 fight 不出移动
  ok('explore 存在且有描述', !!PRESETS.explore?.desc, PRESETS.explore?.desc)
  const p4 = createPolicy('fight')
  const fm = Array.from({ length: 4 }, (_, i) => p4.decide({ motion: 0.01, hudKick: 0 }, { now: i * 100 }).action)
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
  // 2026-10-24 起阶梯里不再有 Enter：看不见提示框时按它只可能白按或打开菜单
  ok('阶梯里不会按确认（Enter 只由提示框驱动）', !kinds.includes('interact'), kinds.join(','))
  ok('阶梯里会出现跳', kinds.includes('jump'), kinds.join(','))
  // 2026-10-24 去掉重击：那和「别盲砍可疑位置」冲突，可破坏物交给接缝分支（有依据才打）
  ok('脱困时不挥刀（不盲砍可疑位置）', !kinds.includes('attack') && !UNSTUCK_LADDER.includes('heavy'), kinds.join(','))
  ok('脱困会掉头（走不通就换方向）', kinds.includes('back') && kinds.includes('jump'), kinds.join(','))
  ok('脱困阶梯是 3 步（退 / 跳 / 跳+上冲）', UNSTUCK_LADDER.length === 3, JSON.stringify(UNSTUCK_LADDER))
  ok('阶梯里有「跳 + 向上冲刺」那一级（空中入口）', UNSTUCK_LADDER.includes('jump-up'), JSON.stringify(UNSTUCK_LADDER))
  // 2026-10-24 用户问「为什么要按 Enter」→ 盲按 Enter 只可能白按或打开菜单，删掉
  ok('脱困阶梯里没有 Enter（看不见提示框时按它有害）', !UNSTUCK_LADDER.includes('interact'), JSON.stringify(UNSTUCK_LADDER))
  ok('脱困阶梯里也没有 Esc（菜单由专门的菜单分支处理）', !UNSTUCK_LADDER.includes('escape'), JSON.stringify(UNSTUCK_LADDER))
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

  // ⑳ 打架时会用 chase —— 但**它不是索敌**：动作只是「按住 dir 走一下 + 点 U」，
  //    U 本身 2026-10-26 实测不转向、不索敌。这条断言只保证「打架时会换位+出剑气」，不保证朝向。
  const pChase = createPolicy('advance')
  const seqFight = []
  for (let i = 0; i < 30; i++) {
    seqFight.push(pChase.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 300 }))
  }
  ok('打架时会用 chase（走一步+点U，非索敌）', seqFight.some((d) => d.action === 'chase'), [...new Set(seqFight.map((d) => d.action))].join(','))
  ok('打架时也会闪现（dash）', seqFight.some((d) => d.action === 'dash'), [...new Set(seqFight.map((d) => d.action))].join(','))
  // ㉑ 文档口径护栏：U / chase 的说明不许再说「索敌 / 朝敌人突进 / 追击」。
  //    同一句错话在 HANDOFF、playbook、control、autoplay 里各写过一遍（2026-10-26 实测推翻），
  //    留一条断言挡住第三次。
  const { PLAYBOOK } = await import('./lib/playbook.mjs')
  const pbText = JSON.stringify(PLAYBOOK)
  const pbBad = pbText.match(/追击|朝敌人突进|自动索敌/g)
  ok('playbook 不再宣称 U/chase 会索敌或突进', !pbBad, pbBad ? pbBad.join(',') : '')
  ok('playbook 明确写了 U 不索敌', /不索敌/.test(pbText), '')

  // ㉒ 转身（face）—— 2026-10-26 真机实测：朝向 = 最后一次移动方向，轻点方向键就翻面；U 不转身。
  {
    const { planAction: planFace, parseActionSpec: parseFace } = await import('./lib/control.mjs')
    const f = planFace({ action: 'face', dir: 'left' })
    ok('face 只按方向键、不点 U', f.steps.length === 1 && f.steps[0].key === 'a',
      f.steps.map((s) => s.key).join('+'))
    ok('face 按住时长压得很短（≤150ms，只为翻面不为走路）', f.steps[0].holdMs <= 150, String(f.steps[0].holdMs))
    const pf = parseFace('face:left:90')
    ok('sequence 里能写 face:left:90', pf && pf.action === 'face' && pf.dir === 'left' && pf.ms === 90, JSON.stringify(pf))
  }
  {
    const { createPolicy: mkPolicy } = await import('./lib/autoplay.mjs')
    const fightFrame = (extra = {}) => ({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, ...extra })
    // ① 连击数 1.6 秒没涨 → 应该翻面
    const pf1 = mkPolicy('advance')
    const seq1 = []
    for (let i = 0; i < 4; i++) seq1.push(pf1.decide(fightFrame(), { now: i * 800 }))
    ok('连击数 1.5 秒没涨 → 会翻面（face）', seq1.some((d) => d.action === 'face'),
      seq1.map((d) => d.action).join(','))
    // ② 翻面要限流：紧挨着的两帧不能连续翻
    const pf2 = mkPolicy('advance')
    const seq2 = []
    for (let i = 0; i < 12; i++) seq2.push(pf2.decide(fightFrame(), { now: i * 200 }))
    const faceIdx = seq2.map((d, i) => (d.action === 'face' ? i : -1)).filter((i) => i >= 0)
    const tooClose = faceIdx.some((i, k) => k > 0 && (i - faceIdx[k - 1]) * 200 < 1200)
    ok('两次翻面之间守住了冷却（不会原地抽搐）', !tooClose, faceIdx.join(','))
    // ③ 知道敌人在哪边时直接朝那边转
    const pf3 = mkPolicy('advance')
    const d3 = pf3.decide(fightFrame({ enemyDir: 'left' }), { now: 1000 })
    ok('看到敌人图标在左边就朝左转', d3.action === 'face' && d3.dir === 'left', `${d3.action}/${d3.dir}`)
    // ④ 回归：连击数**读不到**时（战斗已结束 / HUD 没计数）绝对不能翻面。
    //    2026-10-26 首跑就是这里错了：combo 读不到 ⇒ comboGainAt 永远停在过去
    //    ⇒ 每帧都算「停滞」⇒ 60 秒 face 了 26 次、人一步没走。
    const pf4 = mkPolicy('advance')
    pf4.decide(fightFrame(), { now: 0 })          // 先真的进一次战斗
    const seq4 = []
    for (let i = 1; i <= 10; i++) {
      seq4.push(pf4.decide({ motion: 0.3, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 800 }))
    }
    const faces4 = seq4.filter((d) => d.action === 'face').length
    ok('连击数读不到时不会乱翻面（首跑 26 次抽搐的回归）', faces4 === 0, `face×${faces4}`)
  // ⑥ 血盾都快空了就撤、不再出招（2026-10-26 被打死两次之后补的硬规则）
  {
    const pf5 = mkPolicy('advance')
    // 先喂一帧正常血量，把基线立起来
    pf5.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, hp: 0.6, shield: 0.12 }, { now: 0 })
    const seq5 = []
    for (let i = 1; i <= 3; i++) {
      seq5.push(pf5.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, hp: 0.15, shield: 0.01 }, { now: i * 800 }))
    }
    const d5 = seq5.find((d) => d.action === 'dash')
    ok('低血时先闪开、不追招（不是逃跑：场地有屏障）', !!d5, seq5.map((d) => d.action).join(','))
    ok('后撤方向是背对当前朝向', !!d5 && (d5.dir === 'left' || d5.dir === 'right'), d5?.dir || '')
    // 低血时那两个「花血换免疫」的强化技必须被压掉，否则等于拿命换几帧无敌
    ok('低血时不会去放消耗生命的强化技', !seq5.some((d) => d.action === 'storm' || d.action === 'shade'),
      seq5.map((d) => d.action).join(','))
  }
  // ⑤ icey_dev 的 stamp 必须能算出「进程启动时刻」并扫到代码文件 —— 这是「改动有没有生效」的唯一判据
  {
    const { stampReport } = await import('./lib/devctl.mjs')
    const r = stampReport()
    ok('stamp 扫到了插件自己的代码文件', r.files.length > 5, `${r.files.length} 个`)
    ok('stamp 的进程启动时刻在一小时之内（没算错单位）', Math.abs(Date.now() - r.startedAt) < 3600e3,
      `${Math.round((Date.now() - r.startedAt) / 1000)}s`)
    ok('stamp 能给出未生效改动的条数（可以为 0）', Array.isArray(r.stale), String(r.stale.length))
  }
  }

  // 菜单里的 Esc 由专门的菜单分支负责（见「停在菜单里怎么办」那组测试），
  // 脱困阶梯里不该再有 Esc：本来没菜单却按 Esc，反而会把暂停菜单打开。
  ok('脱困阶梯里不含 Esc', !UNSTUCK_LADDER.includes('escape'), JSON.stringify(UNSTUCK_LADDER))

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
  const dVfx = pVfx.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.07 }, { now: 0 })
  ok('亮闪升高时先闪避而不是硬打', dVfx.action === 'dash', JSON.stringify(dVfx))
  ok('闪避理由写明了数据依据', /亮闪/.test(dVfx.why || ''), dVfx.why)
  const pNoVfx = createPolicy('advance')
  const dNoVfx = pNoVfx.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.03 }, { now: 0 })
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
  const dNar0 = pNar.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, subtitle: 0.05 }, { now: 0 })
  ok('旁白第一帧先等一下（不急着按）', dNar0.action === 'wait', JSON.stringify(dNar0))
  const dNar = pNar.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, subtitle: 0.05 }, { now: 900 })
  ok('旁白连续出现时按确认键', dNar.action === 'interact', JSON.stringify(dNar))
  ok('旁白的理由写明了', /旁白/.test(dNar.why || ''), dNar.why)
  ok('SUBTITLE_MIN 是合理阈值', SUBTITLE_MIN > 0.005 && SUBTITLE_MIN < 0.1, String(SUBTITLE_MIN))

  // ㉕ 探索：会掉头换方向扫图（找宝箱/彩蛋）
  const pExp = createPolicy('explore')
  const seqExp = []
  for (let i = 0; i < 40; i++) seqExp.push(pExp.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5 }, { now: i * 400 }))
  ok('探索时会掉头换方向', seqExp.some((d) => /掉头/.test(d.why || '')), [...new Set(seqExp.map((d) => d.action))].join(','))
  // ㉗ 环境感知：可破坏物要「看见才打」，隐藏房间靠接缝分析，不盲砍
  const EW = 320, EH = 180
  const mkEnv = (fn) => { const b = Buffer.alloc(EW * EH * 4, 0); for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = (y * EW + x) * 4; const [r, g, bl] = fn(x, y); b[i] = r; b[i + 1] = g; b[i + 2] = bl; b[i + 3] = 255 } return b }
  const flat = mkEnv((x, y) => { const v = 60 + (y % 7); return [v, v + 2, v + 6] })
  // 宝箱检测已改成模板匹配（真实样本校准）：把模板贴进一张暗背景里，应该被找到
  const { CHEST_TEMPLATE } = await import('./lib/ui/chest-template.mjs')
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

  // ㊴ 停在菜单里（强化页面）：只按 Esc，绝不按 Enter —— 那里的 Enter 是「升级」，会花钱
  const pMenu = createPolicy('advance')
  const dMenu = pMenu.decide({ motion: 0.02, hudKick: 0, hudBright: 0.07, progress: 0.02, listBands: 13, darkRatio: 0.83, menuRows: 1 }, { now: 0 })
  ok('识别为菜单 → 按 Esc 退出', dMenu.action === 'pause', JSON.stringify(dMenu))
  ok('菜单理由写明了依据', /文字|压暗/.test(dMenu.why || ''), dMenu.why)
  const dMenu2 = pMenu.decide({ motion: 0.02, hudKick: 0, hudBright: 0.07, progress: 0.02, listBands: 13, darkRatio: 0.83, menuRows: 1 }, { now: 300 })
  ok('Esc 有节流（不连按）', dMenu2.action === 'wait', JSON.stringify(dMenu2))
  const dMenu3 = pMenu.decide({ motion: 0.02, hudKick: 0, hudBright: 0.07, progress: 0.02, listBands: 13, darkRatio: 0.83, menuRows: 1 }, { now: 5000 })
  ok('隔 5 秒再次 Esc 并累计计数', dMenu3.action === 'pause' && pMenu.menuEscCount >= 2, String(pMenu.menuEscCount))

  // 菜单里连续 20 秒决策，一次 Enter 都不能出现
  const pMenu4 = createPolicy('advance')
  let sawMenuEnter = false
  for (let t = 0; t < 20000; t += 500) {
    const d = pMenu4.decide({ motion: 0.02, hudKick: 0, hudBright: 0.07, progress: 0.02, listBands: 14, darkRatio: 0.9, menuRows: 1 }, { now: t })
    if (d.action === 'interact') sawMenuEnter = true
  }
  ok('菜单里 20 秒内一次 Enter 都没有', !sawMenuEnter, '')
  const pPlay2 = createPolicy('advance')
  const dPlay2 = pPlay2.decide({ motion: 0.01, hudKick: 0, hudBright: 0.07, progress: 0.5, listBands: 3, darkRatio: 0.5 }, { now: 0 })
  ok('正常画面不会被当成菜单', dPlay2.action !== 'pause', JSON.stringify(dPlay2))
  ok('菜单阈值来自实测范围', MENU_LIST_BANDS >= 8 && MENU_DARK_RATIO > 0.85, `${MENU_LIST_BANDS}/${MENU_DARK_RATIO}`)

  // ㉖e 战斗检测（不靠敌人血条 —— 用户指出大部分怪没血条）
  //     真机实测（连续 100ms 帧）：战斗 motion 中位 24.6%、走路 0.29%、静止 0.70%
  {
    const pIdle = createPolicy('advance')
    let falseFight = 0
    for (let i = 0; i < 20; i++) {
      pIdle.decide({ motion: 0.007, hudKick: 0.005, hudBright: 0.05, progress: 0.9 }, { now: i * 300 })
      if (pIdle.fighting) falseFight++
    }
    ok('空地/走路不会被判成战斗', falseFight === 0, String(falseFight))

    const pFight = createPolicy('advance')
    let sawFight = 0
    for (let i = 0; i < 10; i++) {
      pFight.decide({ motion: 0.246, combo: 1, hudKick: 0.002, hudBright: 0.04, progress: 0.05 }, { now: i * 300 })
      if (pFight.fighting) sawFight++
    }
    ok('战斗中能识别出在打架', sawFight >= 8, String(sawFight))

    pFight.decide({ motion: 0.006, hudKick: 0.002, hudBright: 0.04, progress: 0.9 }, { now: 2900 })
    ok('刚打完 0.2 秒仍在战斗态（粘滞）', pFight.fighting === true, String(pFight.fighting))
    for (let t = 3200; t <= 9000; t += 300) {
      pFight.decide({ motion: 0.006, hudKick: 0.002, hudBright: 0.04, progress: 0.9 }, { now: t })
    }
    ok('安静 6 秒后退出战斗态', pFight.fighting === false, String(pFight.fighting))
    ok('战斗判据的门限来自实测', FIGHT_MOTION >= 0.05 && FIGHT_ACTIVE_RATIO > 0 && FIGHT_ACTIVE_RATIO <= 0.5, `${FIGHT_MOTION}/${FIGHT_ACTIVE_RATIO}`)
  }

  // ㉖d 分阶段连招（取消衔接，来自 BV1314y1k7Zy 的技巧演示）
  const { planAction: planPhase } = await import('./lib/control.mjs')
  const ph = planPhase({ action: 'combo', keys: 'jjji|s+j' }, {})
  ok('分阶段连招生成了 4 点按 + 1 按住', ph.steps.length === 5 && !!ph.steps[4].withSteps, JSON.stringify(ph.steps.map((s) => (s.withSteps ? 'HOLD:' + s.key : s.key))))
  ok('分阶段描述写明了', /分阶段/.test(ph.desc || ''), ph.desc)
  const dashCombo = planPhase({ action: 'combo', keys: 'jo' }, {})
  ok('刺击闪可以表达（J→O）', dashCombo.steps.length === 2 && dashCombo.steps[1].key === 'o', JSON.stringify(dashCombo.steps.map((s) => s.key)))
  ok('取消衔接类连招在表里', COMBOS.some((c) => c.includes('|')) && COMBOS.includes('jo'), JSON.stringify(COMBOS.filter((c) => c.includes('|'))))

  // ㊵ 连段权重：依据社区实战经验（磁阱最高、荡涤最低）
  ok('每条连段都有权重', COMBOS.every((c) => typeof COMBO_WEIGHTS[c] === 'number'), JSON.stringify(COMBOS.filter((c) => typeof COMBO_WEIGHTS[c] !== 'number')))
  ok('权重表里没有多余条目', Object.keys(COMBO_WEIGHTS).every((k) => COMBOS.includes(k)), JSON.stringify(Object.keys(COMBO_WEIGHTS).filter((k) => !COMBOS.includes(k))))
  ok('磁阱权重最高（站桩输出+空档可闪+吸附有伤害）', COMBO_WEIGHTS['jjiii'] === Math.max(...Object.values(COMBO_WEIGHTS)), JSON.stringify(COMBO_WEIGHTS))
  ok('荡涤权重最低（卡手严重）', COMBO_WEIGHTS['iii'] === Math.min(...Object.values(COMBO_WEIGHTS)), JSON.stringify(COMBO_WEIGHTS))
  ok('迭影权重高于荡涤（范围大 vs 卡手）', COMBO_WEIGHTS['jjji'] > COMBO_WEIGHTS['iii'], `${COMBO_WEIGHTS['jjji']} vs ${COMBO_WEIGHTS['iii']}`)
  // 抽一批决策，确认实际打出来的连段里磁阱/迭影多于荡涤
  {
    const pC = createPolicy('advance')
    const seen = {}
    for (let i = 0; i < 600; i++) {
      const d = pC.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 300 })
      if (d.action === 'combo' && d.keys) seen[d.keys] = (seen[d.keys] || 0) + 1
    }
    const top = (seen['jjiii'] || 0) + (seen['jjji'] || 0)
    ok('实战里磁阱+迭影打得比荡涤多', top > (seen['iii'] || 0) * 2, JSON.stringify(seen))
  }

  // ㊲ 处决优先级（用户要求）：看到黄圈+头顶L 立刻按 L，处决完长按 J 吸超载
  const pExec = createPolicy('advance')
  const dExec = pExec.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, executePrompt: true, executeX: 0.6 }, { now: 0 })
  ok('看到处决提示 → 立刻按 L', dExec.action === 'execute', JSON.stringify(dExec))
  ok('处决理由写明了收益', /回血|回盾|结晶/.test(dExec.why || ''), dExec.why)
  const dOver = pExec.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, executePrompt: false }, { now: 1500 })
  ok('处决之后 → 长按 J 吸收超载', dOver.action === 'overload', JSON.stringify(dOver))

  // ㊳ 权重：连段/重击优先级提高（用户要求）
  ok('连段权重最高', ACTION_WEIGHTS.fight.combo >= 10, JSON.stringify(ACTION_WEIGHTS.fight))
  ok('重击权重至少 6', ACTION_WEIGHTS.fight.heavy >= 6, JSON.stringify(ACTION_WEIGHTS.fight))
  ok('重击权重高于普通攻击', ACTION_WEIGHTS.fight.heavy > ACTION_WEIGHTS.fight.attack, JSON.stringify(ACTION_WEIGHTS.fight))

  // ㊱ 画面箭头跟随：游戏给的方向指引要跟着走
  const pArr = createPolicy('advance')
  const dArr = pArr.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, arrowDir: 'right' }, { now: 0 })
  ok('看到箭头 → 按箭头方向走', dArr.action === 'move' && dArr.dir === 'right', JSON.stringify(dArr))
  ok('箭头理由说清了', /箭头/.test(dArr.why || ''), dArr.why)
  const pArrL = createPolicy('advance')
  const dArrL = pArrL.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, arrowDir: 'left' }, { now: 0 })
  ok('箭头向左 → 往左走', dArrL.action === 'move' && dArrL.dir === 'left', JSON.stringify(dArrL))

  // ㉗b 箭头检测器：用真实画面切片做回归（probe/fixtures/arrow-strip.png）
  //    合成贴图不行 —— 模板里大量是暗背景像素，贴出来填充率对不上。
  //    素材必须进仓库（.gitignore 里给它开了例外），否则 CI 上跑不了；
  //    万一缺失就**明确跳过**而不是报错，免得把「素材没带」误当成检测器坏了。
  const { findGuideArrow } = await import('./lib/ui/guide-arrow.mjs')
  const { decodePng } = await import('./lib/png-decode.mjs')
  const fsSync = await import('node:fs')
  const FIX_POS = 'probe/fixtures/arrow-strip.png'
  const FIX_NEG = 'probe/fixtures/arrow-strip-none.png'
  if (!fsSync.existsSync(FIX_POS) || !fsSync.existsSync(FIX_NEG)) {
    console.log('  --    跳过箭头素材回归：probe/fixtures/ 下的截图缺失（不影响其它检查）')
  } else {
    const stripPos = decodePng(fsSync.readFileSync(FIX_POS))
    const posHit = findGuideArrow(stripPos.rgba, stripPos.width, stripPos.height)
    ok('真实画面里的箭头 → 检测到', posHit.hit === true, JSON.stringify(posHit))
    ok('箭头方向 right', posHit.dir === 'right', JSON.stringify(posHit))
    ok('箭头横向位置 ~41%', Math.abs(posHit.x - 0.41) < 0.06, String(posHit.x))
    const stripNeg = decodePng(fsSync.readFileSync(FIX_NEG))
    ok('同一帧的无关区域 → 不误报', findGuideArrow(stripNeg.rgba, stripNeg.width, stripNeg.height).hit === false, '')
  }
  // ㉗c 处决提示：**用真实样本做回归**（2026-10-24 从用户录屏里拿到）
  //     真样本 probe/fixtures/execute-keycap-L.png（录屏 65.0s）：
  //     被打残的怪头上悬浮着一个「黑底 + 白色 L」的键帽，这才是处决提示。
  //     之前一直按「金色环」去找，方向从一开始就是错的 —— 593 + 2299 帧一帧没抓到。
  //     另一张 execute-keycap-U.png（8.0s）是同款键帽但字母是 U（追猎键），
  //     说明**外形判据分不出字母**，检测器会命中它 —— 这是已知局限，不是 bug。
  {
    const FIX_L = 'probe/fixtures/execute-keycap-L.png'
    const FIX_FP = 'probe/fixtures/execute-false-positive.png'
    if (!fsSync.existsSync(FIX_L)) {
      console.log('  --    跳过处决键帽回归：' + FIX_L + ' 缺失（不影响其它检查）')
    } else {
      const { findExecuteKeycap } = await import('./lib/ui/execute-keycap.mjs')
      const lImg = decodePng(fsSync.readFileSync(FIX_L))
      const rL = findExecuteKeycap(lImg.rgba, lImg.width, lImg.height)
      ok('真实处决键帽（黑底白 L）→ 检测到', rL.hit === true, JSON.stringify(rL))
      ok('键帽位置在画面中部偏左', rL.hit && Math.abs(rL.x - 0.44) < 0.08, String(rL.x))
      ok('键帽尺寸符合实测（约 4~5% 画面宽）', rL.hit && rL.bw / lImg.width > 0.03 && rL.bw / lImg.width < 0.07, rL.hit ? String(rL.bw / lImg.width) : '')
      if (fsSync.existsSync(FIX_FP)) {
        const fpImg = decodePng(fsSync.readFileSync(FIX_FP))
        ok('刀光火花不会被当成键帽', findExecuteKeycap(fpImg.rgba, fpImg.width, fpImg.height).hit === false, '')
      }
    }
  }

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
  const dChest = pChest.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, chestConfirmed: true, chestX: 0.85, chestAgeMs: 2000 }, { now: 0 })
  ok('宝箱在右侧 → 朝它走', dChest.action === 'move' && dChest.dir === 'right', JSON.stringify(dChest))
  ok('开宝箱的理由写明了', /宝箱/.test(dChest.why || ''), dChest.why)

  // 策略层：看见可破坏物就朝它走/打；看见接缝就停下观察（不瞎砍）
  const pEnvFar = createPolicy('explore')
  const dFar = pEnvFar.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 3, destructibleX: 0.8 }, { now: 0 })
  ok('可破坏物在右侧 → 走过去', dFar.action === 'move' && dFar.dir === 'right', JSON.stringify(dFar))
  const pEnvNear = createPolicy('explore')
  const dNear = pEnvNear.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 3, destructibleX: 0.5 }, { now: 0 })
  ok('可破坏物在跟前 → 打它', dNear.action === 'attack', JSON.stringify(dNear))
  ok('打可破坏物的理由说清了', /可破坏物/.test(dNear.why || ''), dNear.why)
  // 隐藏房间（宝箱都在里面）⇒ 接缝 = 入口候选，要过去试探而不是站着看
  const pSeam = createPolicy('explore')
  const dSeamFar = pSeam.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, seam: 40, seamX: 0.8 }, { now: 0 })
  ok('接缝在右侧 → 走过去', dSeamFar.action === 'move' && dSeamFar.dir === 'right', JSON.stringify(dSeamFar))
  ok('接缝的理由提到隐藏房间', /隐藏房间/.test(dSeamFar.why || ''), dSeamFar.why)
  const pSeam2 = createPolicy('explore')
  const dSeamNear = pSeam2.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, seam: 40, seamX: 0.5 }, { now: 0 })
  ok('贴到接缝 → 打一下试探暗门', dSeamNear.action === 'attack', JSON.stringify(dSeamNear))
  ok('试探的理由提到暗门', /暗门/.test(dSeamNear.why || ''), dSeamNear.why)

  // 没有可破坏物/接缝时，探索不会平白无故挥刀
  const pNoProbe = createPolicy('explore')
  let blind = 0
  for (let i = 0; i < 60; i++) {
    const d = pNoProbe.decide({ motion: 0.01, hudKick: 0, hudBright: 0.08, progress: 0.5, destructible: 0, seam: 0 }, { now: i * 400 })
    if (d.action === 'attack' && /可疑/.test(d.why || '')) blind++
  }
  ok('不再有「对可疑位置盲砍」', blind === 0, String(blind))

  // ㉖b 组合键（hold + tap）：凝滞 ↓+J / 激发 ↑+J 必须"按住方向期间点 J"
  //     串行写法游戏收不到，这是从 GameScaling 的「时间切片动作」得到启发后修的 bug
  const { planAction: planCombo } = await import('./lib/control.mjs')
  const holdCombo = planCombo({ action: 'combo', keys: 's+j' }, {})
  ok('s+j → 1 个按住步', holdCombo.steps.length === 1, JSON.stringify(holdCombo.steps.map((s) => s.key)))
  ok('s+j 的主键是方向键', holdCombo.steps[0].key === 's', holdCombo.steps[0].key)
  ok('s+j 带子键序列', Array.isArray(holdCombo.steps[0].withSteps) && holdCombo.steps[0].withSteps.length === 1, JSON.stringify(holdCombo.steps[0].withSteps))
  ok('s+j 主键按住时长盖住子键', holdCombo.steps[0].holdMs >= holdCombo.steps[0].withSteps[0].holdMs, String(holdCombo.steps[0].holdMs))
  const holdThree = planCombo({ action: 'combo', keys: 'a+jjj' }, {})
  ok('a+jjj → 3 个子键', holdThree.steps.length === 1 && holdThree.steps[0].withSteps.length === 3, JSON.stringify(holdThree.steps[0].withSteps?.map((s) => s.key)))
  const unknownCombo = planCombo({ action: 'combo', keys: 's+x+j' }, {})
  ok('不认识的按键被忽略且理由里说明', /忽略/.test(unknownCombo.desc || '') && unknownCombo.steps.length === 1, unknownCombo.desc)
  ok('连段表里至少有 2 条组合键（凝滞/激发）', COMBOS.filter((c) => c.includes('+')).length >= 2, JSON.stringify(COMBOS))

  // ㉖c 多轮历史配置与分段分析帧（对齐 GameScaling 的 history_len / image_size）
  const cfgMod = await import('./lib/config.mjs')
  ok('分析帧宽度有默认值', cfgMod.DEFAULTS.analysisWidth >= 320 && cfgMod.DEFAULTS.analysisWidth <= 800, String(cfgMod.DEFAULTS.analysisWidth))
  ok('分析帧宽度会被钳制', cfgMod.normalizeConfig({ analysisWidth: 9999 }).analysisWidth === 800 && cfgMod.normalizeConfig({ analysisWidth: 1 }).analysisWidth === 320, '')

  // ㉗ 连段：出招表来自游戏内招式表，打架时真的会打出来
  ok('连段表非空且都是合法键（含 a/d、o、k=跳跃、组合符 + 与分阶段 |）', COMBOS.length >= 5 && COMBOS.every((c) => /^[jilu89wsadok+|]+$/.test(c)), JSON.stringify(COMBOS))
  // k = 跳跃（空格）：技巧 4「跳凝滞」和 5「万能收刀」都要用跳当起手
  ok('k 映射到跳跃键', (await import('./lib/control.mjs')).planAction({ action: 'combo', keys: 'k' }).steps[0].key === ' ', '')
  const pComb = createPolicy('advance')
  let sawCombo = null
  for (let i = 0; i < 40; i++) {
    const d = pComb.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5 }, { now: i * 300 })
    if (d.action === 'combo') { sawCombo = d; break }
  }
  ok('打架时会打出连段', !!sawCombo, sawCombo ? JSON.stringify(sawCombo) : '40 次决策里没出现 combo')
  if (sawCombo) ok('连段带上了键序列', /^[jilu89wsado+|]+$/.test(sawCombo.keys || ''), String(sawCombo.keys))

  // ㉗b 战斗三档的「遥测」：必须留下能分开三种原因的证据
  //     背景：三档上线后日志里从没出现过低档位，但分不清是「真没掉血」「检测被污染」
  //     还是「基线被锚死」。所以遥测要同时留原始读数、基线和换档记录。
  {
    const { describeCombat } = await import('./lib/autoplay.mjs')
    const pTier = createPolicy('advance')
    // 先满血满盾打几帧（把基线立起来）
    for (let i = 0; i < 6; i++) {
      pTier.decide({ motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, hp: 0.69, shield: 0.10 }, { now: i * 300 })
    }
    const cs0 = pTier.combatStats
    ok('战斗帧会被计入遥测', cs0.frames >= 6, `frames=${cs0.frames}`)
    ok('基线取到了满血实测值', Math.abs(cs0.hpBaseline - 0.69) < 0.001 && Math.abs(cs0.shieldBaseline - 0.10) < 0.001,
      `hp基线=${cs0.hpBaseline} shield基线=${cs0.shieldBaseline}`)
    // 再打到破盾+血少：必须换档，且换档记录里带着原始读数
    for (let i = 6; i < 10; i++) {
      pTier.decide({ motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, hp: 0.30, shield: 0.01 }, { now: i * 300 })
    }
    const cs1 = pTier.combatStats
    ok('掉血破盾后真的会换档', cs1.changes.length >= 1 && cs1.tierFrames.danger > 0,
      `changes=${JSON.stringify(cs1.changes)} danger帧=${cs1.tierFrames.danger}`)
    const ch = cs1.changes[0] || {}
    ok('换档记录带原始读数与基线（能分开「没掉血」和「检测不准」）',
      typeof ch.hp === 'number' && typeof ch.hpBaseline === 'number' && ch.to === 'danger',
      JSON.stringify(ch))
    const desc = describeCombat(cs1)
    ok('档位摘要同时露出原始读数和基线', /原始读数最低/.test(desc) && /基线/.test(desc) && /换档/.test(desc), desc)
    ok('一次都没进战斗时摘要不装懂', /没判定过战斗/.test(describeCombat({ frames: 0 })), describeCombat({ frames: 0 }))
  }

  // ㉗c 摘要里的推进方向必须是实际方向
  //     血泪：预设描述原来写死「往右推进」，dir=left 时日志照样说往右，
  //     上一轮因此误判成「dir 参数没传进来」，白查一轮。
  {
    const runLeft = { seconds: 10, preset: 'advance', dir: 'left', actions: { move: 3 }, events: [], frames: 0, stopped: '测试' }
    const sLeft = summarizeRun(runLeft)
    ok('dir=left 时摘要说往左，不说往右', /往左/.test(sLeft) && !/往右/.test(sLeft), sLeft.split('\n')[0])
    const runRight = { ...runLeft, dir: 'right' }
    const sRight = summarizeRun(runRight)
    ok('dir=right 时摘要说往右', /往右/.test(sRight), sRight.split('\n')[0])
    // 遥测必须进摘要，否则模型看不到「这轮最低血掉到多少」
    const sCombat = summarizeRun({ ...runLeft, combat: { frames: 3, tierFrames: { healthy: 3, cautious: 0, danger: 0 }, minHp: 0.6, minShield: 0.09, minHpRatio: 0.87, minShieldRatio: 0.9, hpBaseline: 0.69, shieldBaseline: 0.10, changes: [] } })
    ok('战斗遥测进了摘要', /战斗档位/.test(sCombat) && /全程没换过档/.test(sCombat), sCombat)
  }

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

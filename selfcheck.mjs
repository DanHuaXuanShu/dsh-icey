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

  // 🔴 2026-10-31 加：实机上线时抓帧连崩两次，这两组断言就是为了不再踩。
  //
  //   崩法一：ClientToScreen 的 _Inout_ POINT 在 koffi 下**不一定回填**，
  //          pt.x 是 undefined ⇒ pt.x - wr.left = NaN ⇒ Math.round(NaN)=NaN
  //          ⇒ Buffer.allocUnsafe(NaN) 抛
  //          "The value of \"size\" is out of range ... Received NaN"。首帧直接抓不到。
  //   崩法二：调用方写 cropBgra(raw, ...) 传了整个 {width,height,data} 对象，
  //          而签名是 (src, sw, sh, x, y, w, h) —— 参数全部错位，报 src.copy is not a function。
  //
  //   崩法二靠改调用点解决；崩法一靠 cropRgba 里的有限性清洗兜住。下面守的就是那层清洗。
  const badUndef = cropRgba(src, 4, 4, undefined, 0, 2, 2)
  eq('裁剪：x=undefined 不崩（当成 0）', [badUndef.width, badUndef.height], [2, 2])
  const badNaN = cropRgba(src, 4, 4, NaN, NaN, NaN, NaN)
  eq('裁剪：全 NaN 不崩（退回全画面）', [badNaN.width, badNaN.height], [4, 4])
  const badOob = cropRgba(src, 4, 4, 999, 999, 999, 999)
  ok('裁剪：越界坐标被夹住而不是返回 0 尺寸',
    badOob.width >= 1 && badOob.height >= 1, `${badOob.width}x${badOob.height}`)
  // 实机真实尺寸：整窗 1606x935、客户区偏移 (2,31)、内容 1600x900
  {
    const big = Buffer.alloc(1606 * 935 * 4)
    const live = cropRgba(big, 1606, 935, 2, 31, 1600, 900)
    eq('裁剪：实机尺寸切出精确 1600x900（16:9）', [live.width, live.height], [1600, 900])
    ok('裁剪：1600x900 是 16:9', Math.abs(live.width / live.height - 16 / 9) < 0.001,
      (live.width / live.height).toFixed(4))
  }
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
    const { classifyScene, StuckDetector, STUCK_MS, hudRatio } = await import('./lib/games/icey/scene.mjs')

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

    // 11. hud 单位归一（2026-10-26 三轮实机 330 秒之后补的回归）
    //     真实 tick 里 analyzeFrame 给的是平均亮度 0~255，而门限按 0~1 比例写 —— 差 255 倍。
    //     旧代码下「HUD 亮一点」就算有进展，45 秒无进展永远攒不满 ⇒ 卡住检测结构上不会触发。
    {
      eq('hudRatio：0~255 亮度均值 → 归一成比例', +hudRatio(64).toFixed(3), 0.251)
      eq('hudRatio：本来就是 0~1 比例的，原样放过', hudRatio(0.25), 0.25)
      const d = new StuckDetector({ stuckMs: STUCK_MS })
      let t = 0
      d.update('explore', { subtitle: 0.001, hud: 64 }, t)
      let stuck = false
      for (t = 1000; t <= STUCK_MS + 5000; t += 1000) {
        stuck = d.update('explore', { subtitle: 0.001, hud: 64 }, t)
      }
      ok('卡住检测：hud 喂 0~255 单位时，45 秒无进展照样判卡住', stuck === true, `t=${t}`)
      // 反过来也要锁：真实的 1~2 个灰阶抖动不能算进展（否则又回到「永不触发」）
      const d2 = new StuckDetector({ stuckMs: STUCK_MS })
      let t2 = 0
      d2.update('explore', { subtitle: 0.001, hud: 64 }, t2)
      let stuck2 = false
      let k = 0
      for (t2 = 1000; t2 <= STUCK_MS + 5000; t2 += 1000) {
        stuck2 = d2.update('explore', { subtitle: 0.001, hud: 64 + (k++ % 2) }, t2)
      }
      ok('卡住检测：±1 灰阶的抖动不算进展', stuck2 === true, `t=${t2}`)
    }

    // 12. 续连不能自锁（2026-10-26 实机：一轮 125 个动作里 46 个是 combo，权重表被架空）
    {
      const { createPolicy: mkPolicy12, MAX_COMBO_CHAIN } = await import('./lib/autoplay.mjs')
      const pol = mkPolicy12('advance')
      const frame = {
        motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5,
        hp: 0.69, shield: 0.10, menuRows: 0,
      }
      let streak = 0
      let maxStreak = 0
      let others = []
      for (let i = 0; i < 60; i++) {
        const d = pol.decide(frame, { now: i * 690 })
        // 2026-10-29：只数**续连**。僵持阶梯第 2 档也会发 combo（换空中起手），
        // 那是另一次独立决策、有自己的限流，混进来会把这条断言变成假警报。
        const isChain = d.action === 'combo' && /续连/.test(d.why || '')
        if (isChain) {
          streak++
          if (streak > maxStreak) maxStreak = streak
        } else {
          streak = 0
          others.push(d.action)
        }
      }
      ok('续连不会自锁：连续续连不超过上限', maxStreak <= MAX_COMBO_CHAIN, `maxStreak=${maxStreak}`)
      ok('续连让位后，权重表里的其它动作真的能出场',
        others.length > 0, `others=${others.join(',')}`)
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
  // 2026-10-29 改：暂停菜单经常要按两次才吃，一次 Enter 只吃掉一层 ⇒ 直接发两次。
  eq('menu resume → Enter 两次', menu.steps.map((s) => s.key), ['Enter', 'Enter'])
  ok('menu resume 两次之间有间隔（背靠背会被游戏当成一次）',
    !!menu.steps[1] && menu.steps[1].gapMs >= 200, 'gapMs=' + (menu.steps[1] && menu.steps[1].gapMs))
  eq('menu back → Esc（只关闭，不选中任何项）',
    planAction({ action: 'menu', item: 'back' }).steps.map((s) => s.key), ['Escape'])
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
  const { analyzeFrame, createPolicy, PRESETS, summarizeRun, STILL_MOTION, FIGHT_HUDKICK, PRESENCE_BRIGHT, PROGRESS_MIN, UNSTUCK_LADDER, MAX_INTERACTS, MAX_BOOT_INTERACTS, PROMPT_MIN, ACTION_WEIGHTS, SUBTITLE_MIN, pickWeighted, COMBOS, COMBO_WEIGHTS, analyzeEnvironment, DESTRUCT_SAT, SEAM_DIFF, VFX_DANGER, VFX_SKIP_TOP, PROMPT_BOX, bossBarFraction, classifyOutcome, RUN_STATUS, createChestTracker, MENU_LIST_BANDS, MENU_DARK_RATIO, FIGHT_MOTION, FIGHT_ACTIVE_RATIO, HUD_GONE_READING, HUD_GONE_FRAMES } = await import('./lib/autoplay.mjs')

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
  // ⚠️ 2026-10-31：坐标必须跟着 HUD_BOX 走，不能写死。
  //    HUD_BOX 从 0.08~0.20 迁到 0.047~0.171（抓帧裁掉了标题栏），
  //    这里原来还按旧值涂，只重叠一部分 → hudBright 读到 0.75 而不是 1，被误判成"功能坏了"。
  const hx0 = Math.floor(W * 0.03), hx1 = Math.floor(W * 0.32)
  const hy0 = Math.floor(H * 0.047), hy1 = Math.floor(H * 0.171)
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
  // 2026-10-31 改：读不到 HUD 时**不再盲按确认键**。
  //   实测踩到：角色死了，画面是「再次作战」死亡菜单，hudBright=0 跟黑屏过场一样，
  //   旧逻辑在这上面按了 Enter —— 而那个菜单里 Enter 就是「再次作战」，会丢进度。
  //   现在一律 wait，把判断交回在场的人（模型看一眼就知道该按什么）。
  const noHud1 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 0 })
  ok('没有 HUD 时第一反应是等，不是盲按确认键', noHud1.action === 'wait', JSON.stringify(noHud1))
  const noHud2 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 300 })
  ok('没有 HUD 时也不连按（一直是 wait）', noHud2.action === 'wait', JSON.stringify(noHud2))
  const noHud3 = p6.decide({ motion: 0.02, hudKick: 0, hudBright: 0 }, { now: 2000 })
  ok('等了两秒之后仍然不按（读不到画面就不该动手）', noHud3.action === 'wait', JSON.stringify(noHud3))

  // ⑬ 有 HUD（在游戏里）时，同样的 motion 应该走正常推进逻辑
  const p7 = createPolicy('advance')
  const hasHud = p7.decide({ motion: 0.02, hudKick: 0, hudBright: 0.08 }, { now: 0 })
  ok('检测到 HUD 时不会乱按确认键', hasHud.action !== 'interact', JSON.stringify(hasHud))
  ok('PRESENCE_BRIGHT 是合理小值', PRESENCE_BRIGHT > 0 && PRESENCE_BRIGHT < 0.05, String(PRESENCE_BRIGHT))

  // ⑬b 整屏界面：血条/护盾/连击都不在画面里 ⇒ 停手，不挥刀（2026-10-27 加）
  //
  // 来由：元叙事控制台（暗红棕整屏终端）实测 hudBright 6~7%，过了 PRESENCE_BRIGHT，
  //   于是被当成游戏画面 —— 接着在战斗分支里「HUD 没读到血量/护盾 → 沿用上一档 → 出招」，
  //   对着一个没有任何操作对象的界面连挥十几秒刀。主菜单大概是同一个洞。
  //   见 HANDOFF「十二·补」。
  const pHudGone = createPolicy('advance')
  const hudGoneActions = []
  for (let i = 0; i < 5; i++) {
    hudGoneActions.push(
      pHudGone.decide({ motion: 0.01, hudKick: 0, hudBright: 0.06, hp: 0, shield: 0, combo: 0 }, { now: i * 300 }).action,
    )
  }
  // 前 HUD_GONE_FRAMES-1 帧是「确认期」，允许照常动作（宁可多动两下，
  // 也不要在真战斗里因为一帧遮挡就停手）；确认之后必须停手，不许再挥刀。
  //
  // 2026-10-29 用户实测改：advance 站在强化台旁看到白字框就按 Enter，
  //   第一次打开强化界面，界面里第二次 Enter 是「升级」⇒ 真花钱（$173→$169）。
  //   所以确认之后的第一步不是干等，而是按 Esc 把误入的界面关掉；之后才停手。
  ok('血盾连击都不在画面里时，确认之后先按 Esc 关界面',
    hudGoneActions[HUD_GONE_FRAMES - 1] === 'menu', hudGoneActions.join(','))
  ok('…关界面之后停手（不再挥刀）',
    hudGoneActions.slice(HUD_GONE_FRAMES).every((a) => a === 'wait'), hudGoneActions.join(','))
  ok('整屏界面只用 Esc，绝不按 Enter（Enter 在强化界面里是「升级」= 花钱）',
    !hudGoneActions.includes('interact'), hudGoneActions.join(','))
  ok('整屏界面里 Esc 只按一次（Esc 无效说明这界面不吃它，再按只是刷屏）',
    hudGoneActions.filter((a) => a === 'menu').length === 1, hudGoneActions.join(','))

  // ⑬c 提示框亮着、人卡住不动 ⇒ 同一段卡住只按 1 次 Enter（2026-10-29 从 2 降到 1）
  //
  // 来由（用户实测）：弥城死镇出生点紧挨一台黄色强化台。
  //   第 1 次 Enter 打开强化界面（钱没动），
  //   第 2 次 Enter 在界面里就是「升级」⇒ 钱从 $173 掉到 $169。
  //   原来给 2 次的理由是「有的门要按两次」，但那条没有任何实测支持，
  //   而「按两次」的代价是实打实的丢钱。
  for (const gap of [400, 1200]) {
    const pPrompt = createPolicy('advance')
    let promptPresses = 0
    for (let i = 0; i < 40; i++) {
      const d = pPrompt.decide({
        motion: 0.002, hudKick: 0, hudBright: 0.08,
        hp: 0.6, shield: 0.09, combo: 0,
        progress: 0, promptBright: 0.003,
      }, { now: i * gap })
      if (d.action === 'interact') promptPresses++
    }
    ok(`提示框一直亮着时只按 1 次 Enter（步长 ${gap}ms）—— 第 2 次在强化界面里就是花钱`,
      promptPresses === 1, '按了 ' + promptPresses + ' 次')
  }
  ok('HUD_GONE_READING 比满血读数低一个量级',
    HUD_GONE_READING > 0 && HUD_GONE_READING < 0.02, String(HUD_GONE_READING))

  // 只读不到一两帧 ⇒ 不下结论（战斗里血条可能被刀光/特效整块遮住）
  const pBlip = createPolicy('advance')
  const blip = []
  for (let i = 0; i < HUD_GONE_FRAMES - 1; i++) {
    const d = pBlip.decide({ motion: 0.01, hudKick: 0, hudBright: 0.06, hp: 0, shield: 0, combo: 0 }, { now: i * 300 })
    blip.push(/整屏界面/.test(d.why ?? '') ? 'wait(整屏)' : d.action)
  }
  ok(`血盾读不到不足 ${HUD_GONE_FRAMES} 帧时不判整屏界面`,
    !blip.some((a) => a.startsWith('wait(整屏)')), blip.join(','))

  // 血条还有读数（哪怕很少）⇒ 不是整屏界面
  const pLow = createPolicy('advance')
  const lowD = pLow.decide({ motion: 0.01, hudKick: 0, hudBright: 0.06, hp: 0.06, shield: 0, combo: 0 }, { now: 0 })
  ok('血条还有读数时不判整屏界面', !/整屏界面/.test(lowD.why ?? ''), JSON.stringify(lowD))

  // 连击数在涨（真在打）⇒ 即使血盾读数这一帧丢了也不停手
  const pFightGone = createPolicy('fight')
  let fightStop = false
  for (let i = 0; i < 6; i++) {
    const d = pFightGone.decide({ motion: 0.04, hudKick: 0, hudBright: 0.06, hp: 0, shield: 0, combo: 0.02 }, { now: i * 300 })
    if (/整屏界面/.test(d.why ?? '')) fightStop = true
  }
  ok('连击数在涨时不判整屏界面', !fightStop, '在战斗中停手了')

  // 没给 hp/shield 字段（手搓指标的老调用方）⇒ 「不知道」不是「读数是 0」
  const pNoField = createPolicy('advance')
  const nf = pNoField.decide({ motion: 0.03, hudKick: 0, hudBright: 0.08, progress: 0.6 }, { now: 0 })
  ok('没给 hp/shield 字段时不判整屏界面', !/整屏界面/.test(nf.why ?? ''), JSON.stringify(nf))

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
    // ⑤ 2026-10-26 四轮真机：`foeDir` 几乎总是非空（金色强化台、左上护盾黄格、连击数字都是黄的），
    //    而原来「翻面」的前提写成了「`!foeDir`」⇒ 346 个动作一次都没翻过。
    //    现在放宽成「指针空 or 指针指着当前朝向」，这条才活得下来。
    // ⚠️ 2026-10-29 改：这里原来断言「指针指着当前朝向且打不中时也会翻面」。
    //    那条是当天早些时候的结论，理由是「foeDir 几乎总是非空 ⇒ 翻面永远不触发」。
    //    但用户看录像指出「黄色箭头在左、角色贴右边一直卡着」，查下来真正的病根是
    //    「箭头 → 走过去接战」这条逻辑写在探索分支里、战斗中根本执行不到。
    //    补上「敌人在画面外就朝箭头走过去」之后，「有箭头时不翻面」不再是死角 ——
    //    因为有更对的反应（走过去）。留着旧断言就等于要求她背对敌人转身。
    //    现在这条改成验新语义：有箭头时**不许**翻面背对它，但必须朝它走过去。
    const pf5b = mkPolicy('advance')
    pf5b.decide(fightFrame({ enemyDir: 'right' }), { now: 0 })   // 朝向 right，指针也指 right
    const seq5b = []
    for (let i = 1; i <= 6; i++) {
      seq5b.push(pf5b.decide(fightFrame({ enemyDir: 'right' }), { now: i * 800 }))
    }
    ok('指针指着敌人时不会翻面背对它（改为朝那边走）',
      !seq5b.some((d) => d.action === 'face'),
      seq5b.map((d) => d.action).join(','))
    ok('指针指着敌人时会朝那边走过去（这才是有用的反应）',
      seq5b.some((d) => d.action === 'move' && d.dir === 'right'),
      seq5b.map((d) => `${d.action}${d.dir ? ':' + d.dir : ''}`).join(','))
    // ⑥ 处决节流：提示一直挂着，也不能每帧都按 L（键帽检测分不出 L/U/E，误判会锁死战斗）
    const pEx = mkPolicy('advance')
    const exSeq = []
    for (let i = 0; i < 8; i++) {
      exSeq.push(pEx.decide({
        motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, executePrompt: true,
      }, { now: i * 300 }))
    }
    const exCount = exSeq.filter((d) => d.action === 'execute').length
    ok('处决有冷却：提示挂着也不会每 300ms 按一次 L', exCount <= 2, `execute×${exCount}/8`)
    // ⑥b 处决快通道的「账只有一处」（2026-10-26 加）
    //   主循环 0.89 秒一步、L 键帽只亮 0.3~0.5 秒 ⇒ 开了条只抓帧看键帽的旁路。
    //   旁路如果自己记一套冷却，它和 decide() 就会各按各的 —— 所以冷却/计数必须走 policy。
    {
      const pFast = mkPolicy('advance')
      ok('policy 提供快通道要用的 canExecute / noteExecute',
        typeof pFast.canExecute === 'function' && typeof pFast.noteExecute === 'function',
        typeof pFast.canExecute)
      ok('刚开局就能处决（没有被永久冷却卡死）', pFast.canExecute(100_000) === true, '')
      const nth = pFast.noteExecute(100_000)
      ok('noteExecute 记成「第 1 次」', nth === 1, `nth=${nth}`)
      ok('记过一次之后，冷却期内不能再处决', pFast.canExecute(100_000 + 300) === false, '')
      ok('冷却过了又能处决', pFast.canExecute(100_000 + 2000) === true, '')
      // 次数上限要管住快通道（否则旁路会在战斗里刷成连按）
      let guard = 0
      let t = 200_000
      while (pFast.canExecute(t) && guard < 100) { pFast.noteExecute(t); t += 2000; guard++ }
      ok('次数上限会拦住快通道，不会无限按', guard <= pFast.executeLimit, `按了 ${guard} 次，上限 ${pFast.executeLimit}`)
      // 设计约束：键帽只亮 0.3~0.5 秒，两帧之间不能隔太久，否则一段里只能看一次
      const fsSync = await import('node:fs')
      const src = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
      const poll = Number((src.match(/EXEC_FAST_POLL_MS\s*=\s*(\d+)/) || [])[1])
      ok('快通道的采样间隔够密（键帽只亮 0.3~0.5 秒）',
        Number.isFinite(poll) && poll > 0 && poll <= 200, `poll=${poll}`)
      ok('快通道用比分析帧更小的图抓（省时间）',
        /EXEC_FAST_WIDTH\s*=\s*(\d+)/.test(src) && Number((src.match(/EXEC_FAST_WIDTH\s*=\s*(\d+)/) || [])[1]) <= 400, '')
      // 关键设计：快通道必须并行在「等动作」里跑，不能单独占时间 ——
      // 否则每个战斗步多站 0.3 秒，正好把提速收益吃掉。
      ok('快通道并进「等动作」里跑，不额外占主循环时间',
        /#waitIdleLookingForExecute/.test(src), '')
    }

    // ⑦ 低血门槛放宽：她死在 血 38.9% / 盾 0%，而旧判据要求「血<30% 且 盾<20%」两条同时成立。
    const pLow = mkPolicy('advance')
    pLow.decide({ motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, hp: 0.6, shield: 0.12 }, { now: 0 })
    const dLow = pLow.decide({ motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, hp: 0.25, shield: 0.004 }, { now: 2000 })
    ok('血 42% + 破盾 → 进低血模式（旧 30% 门槛放过了她）', dLow.action === 'dash',
      `${dLow.action}｜${dLow.why || ''}`)
    // ⑧ 字幕裁图（2026-10-26 加）：插件不做 OCR，把字幕区按原分辨率裁出来交给模型读。
    //    框必须合法、且比分析用的 SUBTITLE_BOX 更宽 —— 裁窄了会把句首句尾的字切掉。
    {
      const L = await import('./lib/games/icey/layout.mjs')
      const c = L.SUBTITLE_CROP
      const b = L.SUBTITLE_BOX
      ok('字幕裁图框在画面内且不自相矛盾',
        c.x0 >= 0 && c.y0 >= 0 && c.x1 <= 1 && c.y1 <= 1 && c.x0 < c.x1 && c.y0 < c.y1,
        JSON.stringify(c))
      ok('字幕裁图框比分析框宽（不切字）',
        c.x0 <= b.x0 && c.x1 >= b.x1 && c.y0 <= b.y0 && c.y1 >= b.y1,
        `crop=${JSON.stringify(c)} box=${JSON.stringify(b)}`)
    }
    // ⑨ 字幕优先于交互提示：agent.js 里先找 subtitle 帧、再找 prompt 帧。
    //    旁白在说什么，比「这里能不能按 Enter」更影响决策（ICEY 的 Meta 核心）。
    {
      const { promises: fsp } = await import('node:fs')
      const src = await fsp.readFile(new URL('./agent.js', import.meta.url), 'utf8')
      const iSub = src.indexOf("reason === 'subtitle'")
      const iPrompt = src.indexOf("reason === 'prompt'")
      ok('agent.js 把字幕裁图排在交互提示之前（Meta 旁白优先）',
        iSub > 0 && iPrompt > 0 && iSub < iPrompt, `sub@${iSub} prompt@${iPrompt}`)
    }
    // ⑩ 读字之后怎么办：规则卡必须有旁白/元叙事那一节，并且写清 Q/E 是什么。
    //    2026-10-26 加 —— 字幕图已经递上去了，没有这一节模型不知道该听还是该反。
    {
      const { PLAYBOOK } = await import('./lib/playbook.mjs')
      ok('规则卡有「旁白/元叙事」一节', Array.isArray(PLAYBOOK.narration) && PLAYBOOK.narration.length >= 5,
        `narration=${PLAYBOOK.narration?.length}`)
      const npb = (PLAYBOOK.narration || []).join('\n')
      ok('规则卡写清 Q=是 / E=否', /Q\s*=\s*是/.test(npb) && /E\s*=\s*否/.test(npb), '')
      ok('规则卡给了「默认先照做一次」的判据', /先照做一次/.test(npb), '')
      ok('digest 里也提醒了旁白与 Q/E', /旁白/.test(PLAYBOOK.digest) && /Q\s*=\s*是/.test(PLAYBOOK.digest), '')
      const { KINDS } = await import('./lib/events.mjs')
      ok('dialog-wait 已登记为正式事件 kind', KINDS.includes('dialog-wait'), KINDS.join(','))
      // 「看见了敌情却没朝那边走」——只记信号、不改决策。
      // 没有这条事件，「没看见敌人」和「看见了被别的分支挡住」在日志里长得一模一样。
      ok('enemy-ignored 已登记为正式事件 kind', KINDS.includes('enemy-ignored'), KINDS.join(','))
      // 处决快通道「真的在跑」的实证（没有它，跑完分不清「没遇到键帽」和「旁路没启动」）
      ok('exec-look 已登记为正式事件 kind', KINDS.includes('exec-look'), KINDS.join(','))
    }
    // ⑫ 操控分工写进插件（2026-10-26 用户立的规矩：模型要亲手按，不能只托管）
    //    这一条必须活在**三处**才算数：规则卡、digest、工具描述。
    //    只写规则卡的话，模型不看规则卡就失效；只写工具描述的话，它读不到为什么。
    {
      const { PLAYBOOK, playbookText } = await import('./lib/playbook.mjs')
      ok('规则卡有「谁的手在键盘上」一节', Array.isArray(PLAYBOOK.hands) && PLAYBOOK.hands.length >= 4,
        `hands=${PLAYBOOK.hands?.length}`)
      const h = (PLAYBOOK.hands || []).join('\n')
      ok('规则卡写清分工：平时你按、战斗插件为主',
        /平时（探路|你控制|你按）/.test(h) && /战斗：插件为主/.test(h), '')
      ok('规则卡写清战斗里模型拧哪两个旋钮（focus / style）',
        /focus/.test(h) && /style/.test(h) && /微调/.test(h), '')
      ok('规则卡给了两种托管上限（非战斗 60 / 战斗 120）',
        /PLAY_MAX_SECONDS/.test(h) && /PLAY_MAX_SECONDS_FIGHT/.test(h), '')
      ok('规则卡提醒「命令发出去 ≠ 键进了游戏」', /0\.00%/.test(h) || /键真的进/.test(h), '')
      ok('digest 也写了分场景分工', /平时你按/.test(PLAYBOOK.digest) && /background:true/.test(PLAYBOOK.digest), '')
      const txt = playbookText()
      ok('规则卡渲染出了这一节', /谁的手在键盘上/.test(txt), '')
      const fsSync = await import('node:fs')
      const agentSrc = fsSync.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
      ok('icey_play 的工具描述里写明「战斗默认这样用」',
        /战斗默认这样用/.test(agentSrc), '')
      ok('icey_act 的工具描述里写明「平时用这个」',
        /平时用这个/.test(agentSrc), '')
    }
    // ㊱ 在场哨兵：**模型不参与时，插件也不许操作**（2026-10-27 用户追加的规矩）
    //    为什么必须有代码而不是只写规则：2026-10-27 19:20 模型为了省调用，
    //    把 90 秒整段丢给 icey_play，自己只发了 7 秒动作 —— 规则写得再清楚也被绕过。
    {
      const fsSync = await import('node:fs')
      const { PRESENCE_TIMEOUT_MS, PLAY_MAX_SECONDS, PLAY_MAX_SECONDS_FIGHT, PLAY_COOLDOWN_MS } = await import('./lib/game.mjs')
      ok('导出在场哨兵常量', Number.isFinite(PRESENCE_TIMEOUT_MS) && PRESENCE_TIMEOUT_MS > 0,
        String(PRESENCE_TIMEOUT_MS))
      ok('在场超时量级合理（30 秒~5 分钟）',
        PRESENCE_TIMEOUT_MS >= 30_000 && PRESENCE_TIMEOUT_MS <= 300_000, String(PRESENCE_TIMEOUT_MS))
      ok('单段托管硬上限 ≤60 秒', PLAY_MAX_SECONDS > 0 && PLAY_MAX_SECONDS <= 60, String(PLAY_MAX_SECONDS))
      ok('战斗段上限更宽（>60 且 ≤180）',
        PLAY_MAX_SECONDS_FIGHT > PLAY_MAX_SECONDS && PLAY_MAX_SECONDS_FIGHT <= 180, String(PLAY_MAX_SECONDS_FIGHT))
      const gameSrc0 = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
      ok('play() 按 preset=fight 放开上限', /wantFight/.test(gameSrc0) && /PLAY_MAX_SECONDS_FIGHT/.test(gameSrc0), '')
      ok('两段之间要留间隔（≥5 秒）', PLAY_COOLDOWN_MS >= 5_000, String(PLAY_COOLDOWN_MS))
      const gameSrc = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
      ok('play() 里真的检查了模型是否在场', /modelTouchedAt/.test(gameSrc) && /PRESENCE_TIMEOUT_MS/.test(gameSrc), '')
      ok('act() 会刷新在场计时器', /async act\(input[^)]*\)\s*\{[\s\S]{0,200}modelTouchedAt = Date\.now\(\)/.test(gameSrc), '')
      ok('look() 也会刷新在场计时器', /async look\(opts[^)]*\)\s*\{[\s\S]{0,200}modelTouchedAt = Date\.now\(\)/.test(gameSrc), '')
      ok('上一段结束时间被记下来（cooldown 用）', /lastPlayEndedAt = Date\.now\(\)/.test(gameSrc), '')
      const agentSrc2 = fsSync.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
      ok('icey_play 描述里写明后台战斗的硬闸', /后台战斗自动停手/.test(agentSrc2), '')
      const { PLAYBOOK } = await import('./lib/playbook.mjs')
      const h2 = (PLAYBOOK.hands || []).join('\n')
      ok('规则卡写明「你不参与时插件也不许操作」', /你不参与时/.test(h2) && /不许操作/.test(h2), '')
      ok('digest 也写了在场才动手', /你在场才动手/.test(PLAYBOOK.digest), '')
    }
    // ⑪ 字幕「行」检测：细笔画白字算，成片亮块不算。
    //    2026-10-26 两轮实机各裁到一张空字幕图（框里只有草和脚）——旧判据只看亮像素占比。
    {
      const { findBrightTextRows } = await import('./lib/ui/scan.mjs')
      const L = await import('./lib/games/icey/layout.mjs')
      const W = 480, H = 278
      const mk = (paint) => {
        const buf = new Uint8Array(W * H * 4)
        for (let i = 0; i < buf.length; i += 4) { buf[i] = 20; buf[i + 1] = 20; buf[i + 2] = 20; buf[i + 3] = 255 }
        paint(buf)
        return buf
      }
      const white = (buf, x, y) => {
        if (x < 0 || x >= W || y < 0 || y >= H) return
        const i = (y * W + x) * 4
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255
      }
      // 文字行：SUBTITLE_BOX 里、每 12px 两根白像素（细笔画）
      const textFrame = mk((buf) => {
        const y0 = Math.round(0.82 * H)
        for (let y = y0; y < y0 + 6; y++) {
          for (let x = 60; x < W - 60; x += 12) { white(buf, x, y); white(buf, x + 1, y) }
        }
      })
      const textRows = findBrightTextRows(textFrame, W, H, L.SUBTITLE_BOX)
      ok('字幕检测：成行的细笔画白字 → 认得出', textRows.length >= 1, JSON.stringify(textRows))
      // 成片亮块（亮草/白花/特效）：密度超上限，不该被当成字幕
      const blockFrame = mk((buf) => {
        for (let y = Math.round(0.78 * H); y < Math.round(0.92 * H); y++) {
          for (let x = 40; x < 400; x++) white(buf, x, y)
        }
      })
      const blockRows = findBrightTextRows(blockFrame, W, H, L.SUBTITLE_BOX)
      ok('字幕检测：成片亮块 → 不算字幕', blockRows.length === 0, JSON.stringify(blockRows))
    }
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
    // HUD 读不到（m.hp/m.shield 缺失）≠ 血是 0：不许因此进低血模式
    const pf6 = mkPolicy('advance')
    pf6.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, hp: 0.6, shield: 0.12 }, { now: 0 })
    const seq6 = []
    for (let i = 1; i <= 4; i++) {
      seq6.push(pf6.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08 }, { now: i * 800 }))
    }
    const panic6 = seq6.filter((d) => /低血/.test(d.why || '')).length
    ok('HUD 读不到时不会误进低血模式（?? 0 的坑）', panic6 === 0, `低血×${panic6}`)
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
  // 🔴 2026-10-31 加：PROMPT_BOX 的 y0 必须盖住三行提示，否则判据只靠后两行撑着。
  //    实机截图（1602x932，标题栏 32px，客户区 1602x900）量出三行文字占 0.464~0.567。
  //    旧值 0.50（含标题栏口径 = 0.482）一直切掉第一行，只是从没人量过。
  ok('PROMPT_BOX 顶部必须高于提示文字顶（0.464），否则第一行被切',
    PROMPT_BOX.y0 < 0.464, `y0=${PROMPT_BOX.y0}`)
  ok('PROMPT_BOX 底部要盖住最后一行（0.567）',
    PROMPT_BOX.y1 > 0.567, `y1=${PROMPT_BOX.y1}`)
  // 注意别写成「不能和 SUBTITLE_BOX 的定义框重叠」—— 那个框从 0.689 就开始了，
  // 但字幕**文字**实测在 0.90~0.94，两者中间是空的。重叠定义框本身无害，
  // 有害的是把字幕文字圈进来（那会把「有旁白」误判成「有互动提示」）。
  ok('PROMPT_BOX 别圈到字幕文字（实测在 0.90 以上）',
    PROMPT_BOX.y1 < 0.85, `y1=${PROMPT_BOX.y1}`)
  // 🔴 2026-10-31 加：提示框是**跟着角色跑**的，横坐标必须覆盖角色在左/中/右三种位置。
  //    实测：迷路森林（角色在右）提示框 x 0.73~0.84；选择之间（角色在中）x 0.45~0.555。
  //    旧 x0=0.55 只跟后者重叠 5px，等于框不到 —— 这才是「有些地方死活开不了强化台」的原因。
  ok('PROMPT_BOX 左边要够到角色居中时的提示框（x≈0.45）',
    PROMPT_BOX.x0 <= 0.46, `x0=${PROMPT_BOX.x0}`)
  ok('PROMPT_BOX 右边要够到角色靠右时的提示框（x≈0.84）',
    PROMPT_BOX.x1 >= 0.85, `x1=${PROMPT_BOX.x1}`)

  // 抓帧：黑帧重试 + 过场黑屏 vs 真故障的区分
  {
    const { grabFrame } = await import('./lib/vision.mjs')
    const mkBackend = (seq, o = {}) => {
      let i = 0
      return {
        async capture() {
          const spec = seq[Math.min(i++, seq.length - 1)]
          return spec === 'black'
            ? { ok: true, width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4) }
            : { ok: true, width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 200) }
        },
        async alive() { return { ok: true, alive: o.alive !== false, minimized: !!o.minimized } },
        async find() { return { ok: true, found: true, foreground: o.foreground !== false } },
      }
    }
    const r1 = await grabFrame(mkBackend(['black', 'black', 'ok']), 1)
    ok('黑帧会重试：第 3 次正常就算成功', r1.ok === true && r1.health?.attempts === 3, JSON.stringify(r1.health))
    const r2 = await grabFrame(mkBackend(['black']), 1)
    ok('连续黑帧且窗口在前台 ⇒ 判为过场（blackout），不是故障', r2.ok === false && r2.blackout === true, String(r2.error))
    ok('过场文案不误导成「最小化」', !/最小化/.test(r2.error || ''), r2.error)
    const r3 = await grabFrame(mkBackend(['black'], { minimized: true }), 1)
    ok('连续黑帧且窗口最小化 ⇒ 明说最小化', /最小化/.test(r3.error || ''), r3.error)
    const r4 = await grabFrame(mkBackend(['black'], { alive: false }), 1)
    ok('连续黑帧且窗口没了 ⇒ 说清窗口不在', /不在|关掉/.test(r4.error || ''), r4.error)
  }

  // Boss 血条：从实机录像量的位置（1920x1080 上 y 0.904~0.912，x 0.184~0.813）
  {
    const mkBar = (W, H, l, r) => {
      const buf = Buffer.alloc(W * H * 4)
      const y0 = Math.floor(H * 0.901)
      const y1 = Math.ceil(H * 0.914)
      const xa = Math.floor(W * l)
      const xb = Math.floor(W * r)
      for (let y = y0; y < y1; y++) {
        for (let x = xa; x < xb; x++) {
          const i = (y * W + x) * 4
          buf[i] = 220; buf[i + 1] = 30; buf[i + 2] = 40; buf[i + 3] = 255
        }
      }
      return buf
    }
    const full = bossBarFraction(mkBar(1920, 1080, 0.184, 0.813), 1920, 1080)
    ok('Boss 血条：满血读 100%', full !== null && Math.abs(full - 1) < 0.02, String(full))
    const half = bossBarFraction(mkBar(1920, 1080, 0.184, 0.4985), 1920, 1080)
    ok('Boss 血条：半血读 50%', half !== null && Math.abs(half - 0.5) < 0.03, String(half))
    ok('Boss 血条：没有红条时返回 null', bossBarFraction(Buffer.alloc(1600 * 900 * 4), 1600, 900) === null, '')
    // 左端校验：红块不在血条起点 ⇒ 不是血条（防止把受击红光/特效当成 Boss 血）
    const offLeft = bossBarFraction(mkBar(1920, 1080, 0.45, 0.7), 1920, 1080)
    ok('Boss 血条：红块左端不对时判为 null（不是血条）', offLeft === null, String(offLeft))
    // 换分辨率仍要能用（实机抓帧可能是 1600x900 / 1280x720）
    const small = bossBarFraction(mkBar(1280, 720, 0.184, 0.4985), 1280, 720)
    ok('Boss 血条：1280x720 也读得出', small !== null && Math.abs(small - 0.5) < 0.04, String(small))
    // 成绩单要说出「打掉了几条血」—— 用户第一次打犹大时，打了 300 秒血条一格不动，
    // 托管当时完全没有手段知道这件事。
    const bossReport = summarizeRun({
      seconds: 30, preset: 'fight', dir: 'right', actions: {}, events: [], frames: 0, stopped: '跑满',
      combat: { bossBarSeen: true, bossBarWipes: 2, bossBarMin: 0.15, frames: 30 },
    })
    ok('成绩单报告 Boss 战：说清打空几条血', /Boss 战/.test(bossReport) && /打空了 2 条血/.test(bossReport), bossReport)
    const noBossReport = summarizeRun({
      seconds: 30, preset: 'advance', dir: 'right', actions: {}, events: [], frames: 0, stopped: '跑满',
      combat: { frames: 30 },
    })
    ok('没有 Boss 血条时成绩单不瞎报 Boss 战', !/Boss 战/.test(noBossReport), noBossReport)

    // 结局五档：拿 game.mjs 里**真实的 stopped 文案**逐个验证分类
    // （这组断言是「文案改了要回来改分类」的保险 —— 分类函数只在一处，但文案散在 game.mjs）
    const cases = [
      ['插件被停止', RUN_STATUS.aborted],
      ['画面连续 12 帧完全不变（这期间按了 5 次键）—— 游戏大概率已无响应，不是卡住。停手把画面交回', RUN_STATUS.failed],
      ['任务达成：已脱离战斗（画面里没敌人、没屏障），用时 42s', RUN_STATUS.completed],
      ['抓帧失败：The value of "size" is out of range', RUN_STATUS.failed],
      ['帧不可用', RUN_STATUS.failed],
      ['手动停手（icey_play stop）', RUN_STATUS.aborted],
      ['在场哨兵：模型已经 95 秒没参与（icey_act / icey_look），后台战斗自动停手', RUN_STATUS.aborted],
      ['动作非法（jump）：boom', RUN_STATUS.failed],
      ['画面一直停在菜单/强化界面：已按 3 次 Esc 仍未退出。为避免误按「升级」花钱，先停在这里，请人工确认界面状态。', RUN_STATUS.partial],
      ['连着几轮都没进展：这里可能是一扇打不开的门、解谜或分支选择 —— 停下把画面交回，由模型/人来判断', RUN_STATUS.partial],
      ['玩满 60 秒', RUN_STATUS.completed],
    ]
    let allGood = true
    const wrong = []
    for (const [text, want] of cases) {
      const got = classifyOutcome({ stopped: text })
      if (got !== want) { allGood = false; wrong.push(`${text.slice(0, 12)}…→${got}(要${want})`) }
    }
    ok('连玩的 11 种结束原因都能正确分档', allGood, wrong.join(' / '))
    ok('带了 error 字段一律算失败',
      classifyOutcome({ stopped: '玩满 30 秒', error: 'boom' }) === RUN_STATUS.failed, '')
    // 这条是本轮的核心：跑满了、也一直在打，但 Boss 血条没动 —— 旧写法会报「完成」
    ok('Boss 战血条没动 ⇒ 部分完成（不是完成）',
      classifyOutcome({
        stopped: '玩满 60 秒',
        combat: { bossBarSeen: true, bossBarWipes: 0, bossBarMin: 1 },
      }) === RUN_STATUS.partial, '')
    ok('Boss 战打掉过血 ⇒ 不算部分完成',
      classifyOutcome({
        stopped: '玩满 60 秒',
        combat: { bossBarSeen: true, bossBarWipes: 0, bossBarMin: 0.62 },
      }) === RUN_STATUS.completed, '')
    ok('Boss 战打空过一条血 ⇒ 完成',
      classifyOutcome({
        stopped: '玩满 60 秒',
        combat: { bossBarSeen: true, bossBarWipes: 2, bossBarMin: 0.4 },
      }) === RUN_STATUS.completed, '')
  // 体检：四档徽章（架构参考 dsh-game-daily）
  {
    // 先补回结局分档那条：成绩单第一行必须是分档
    const statusLine = summarizeRun({
      seconds: 5, preset: 'advance', actions: {}, events: [], frames: 0, stopped: '玩满 5 秒',
    })
    ok('成绩单第一行写着结局分档', /^【完成】/.test(statusLine), statusLine.split('\n')[0])
    const { makeItem, worstLevel, countByLevel, renderDoctor, DIAG_LEVEL } = await import('./lib/doctor.mjs')
    ok('体检：总结论取最坏那一档',
      worstLevel([
        makeItem('a', '甲', DIAG_LEVEL.ready, ''),
        makeItem('b', '乙', DIAG_LEVEL.blocked, ''),
        makeItem('c', '丙', DIAG_LEVEL.risk, ''),
      ]) === DIAG_LEVEL.blocked, '')
    ok('体检：没有阻断时取次坏的',
      worstLevel([
        makeItem('a', '甲', DIAG_LEVEL.ready, ''),
        makeItem('c', '丙', DIAG_LEVEL.risk, ''),
      ]) === DIAG_LEVEL.risk, '')
    ok('体检：空列表算就绪', worstLevel([]) === DIAG_LEVEL.ready, '')
    const cnt = countByLevel([
      makeItem('a', '', DIAG_LEVEL.ready, ''), makeItem('b', '', DIAG_LEVEL.ready, ''),
      makeItem('c', '', DIAG_LEVEL.missing, ''), makeItem('d', '', DIAG_LEVEL.blocked, ''),
    ])
    ok('体检：各档计数正确', cnt.ready === 2 && cnt.missing === 1 && cnt.blocked === 1 && cnt.risk === 0, JSON.stringify(cnt))

    const text = renderDoctor([
      makeItem('ok1', '游戏窗口', DIAG_LEVEL.ready, '已接上'),
      makeItem('bad', '画面比例', DIAG_LEVEL.blocked, '1.6（不是 16:9）', '把游戏设成 16:9'),
      makeItem('warn', '前台策略', DIAG_LEVEL.risk, 'allowFocus 关着', '打开 allowFocus'),
    ])
    ok('体检：第一行给总结论', /^《艾希》插件体检：阻断/.test(text), text.split('\n')[0])
    ok('体检：阻断项排在就绪项前面',
      text.indexOf('画面比例') < text.indexOf('游戏窗口'), '')
    ok('体检：非就绪项带「→ 下一步」', /→ 把游戏设成 16:9/.test(text) && /→ 打开 allowFocus/.test(text), '')
    ok('体检：有阻断时结语是「跑不起来」', /跑不起来/.test(text), '')
    const okText = renderDoctor([makeItem('ok1', '游戏窗口', DIAG_LEVEL.ready, '已接上')])
    ok('体检：全绿时结语说可以跑', /全部就绪/.test(okText) && !/→/.test(okText), '')
    ok('体检：空列表不崩，且说明这本身不对', /没有任何检查项/.test(renderDoctor([])), '')
  }
  } // ← 关闭上面那个从「Boss 血条」开始的大块（2026-10-31 补：加体检断言时漏了这一个）

  // ㉘ 预警闪避：亮闪≥VFX_DANGER 就先闪。
  //
  // 🔴 2026-10-31 这段整块重写 —— 原来的断言是在**错的尺度**上钉死的：
  //    旧注释「24 分钟数据：大伤害前 6.61% vs 全局 4.09%」里的 4.09 / 6.61
  //    是在**带窗口标题栏**的帧上量的（capture 走 GetWindowRect，含 13 行纯白标题栏，
  //    白条自己就贡献约 3% 的「很亮像素」）。
  //    所以「VFX_DANGER 落在 4.1%~6.6% 之间」这条断言，本质上是在守护一个 bug：
  //    它要求常量必须落在一个只有标题栏才存在的区间里。
  //
  //    正确的尺度（跳过顶部 4% 之后，2422 帧实测）：
  //      掉血帧   p50 0.12%  p75 0.40%  p95 4.12%
  //      非掉血帧  p50 0.12%  p75 0.42%  p95 2.83%
  //    中位数一样 ⇒ 这条判据本身就弱，阈值按「代价不对称」定在 3%（TPR 10% / FPR 4.5%）。
  ok('VFX_DANGER 落在内容区尺度的合理区间（1.5%~5%）',
    VFX_DANGER > 0.015 && VFX_DANGER < 0.05, String(VFX_DANGER))
  // 🔴 2026-10-31 改：标题栏改成在**抓帧时裁掉**之后，二次跳过必须归零（否则重复裁剪）。
  // 这条断言的含义也跟着变了：现在它守护的是「不要双重裁剪」，而不是「必须跳过标题栏」。
  ok('标题栏已在抓帧时裁掉 ⇒ vfx 不再二次跳过顶部（防双重裁剪）',
    VFX_SKIP_TOP === 0, String(VFX_SKIP_TOP))
  const pVfx = createPolicy('advance')
  const dVfx = pVfx.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.07 }, { now: 0 })
  ok('亮闪升高时先闪避而不是硬打', dVfx.action === 'dash', JSON.stringify(dVfx))
  ok('闪避理由写明了数据依据', /亮闪/.test(dVfx.why || ''), dVfx.why)
  // 「不乱闪」的样本必须低于新阈值：旧样本是 0.03（= 新阈值的等号，必然误触发），
  // 那是断言写死了旧常量、而不是行为变坏了。改成明显低于阈值的 0.01。
  const pNoVfx = createPolicy('advance')
  const dNoVfx = pNoVfx.decide({ motion: 0.3, combo: 1, hudKick: 0.1, hudBright: 0.08, progress: 0.5, vfx: 0.01 }, { now: 0 })
  ok('亮闪正常时不乱闪', dNoVfx.action !== 'dash' || !/亮闪/.test(dNoVfx.why || ''), JSON.stringify(dNoVfx))

  // ㉓ 行动权重：确定性 + 每个 preset 的权重表都存在
  ok('pickWeighted 是确定性的', pickWeighted(ACTION_WEIGHTS.fight, 42) === pickWeighted(ACTION_WEIGHTS.fight, 42), '')
  ok('advance/explore/fight 都有权重表', !!(ACTION_WEIGHTS.advance && ACTION_WEIGHTS.fight && ACTION_WEIGHTS.explore), Object.keys(ACTION_WEIGHTS).join(','))
    const fightTotal = Object.values(ACTION_WEIGHTS.fight).reduce((a, b) => a + b, 0)
  const atkShare = (ACTION_WEIGHTS.fight.combo + ACTION_WEIGHTS.fight.heavy + ACTION_WEIGHTS.fight.attack) / fightTotal
  const moveShare = (ACTION_WEIGHTS.fight.dash + ACTION_WEIGHTS.fight.chase + (ACTION_WEIGHTS.fight.move || 0)) / fightTotal
  ok('战斗时攻击占比 ≥70%（用户要求攻击欲望高）', atkShare >= 0.7, (atkShare * 100).toFixed(1) + '%')
  // 2026-10-27 用户要求「闪避更频繁（中等档：一档 dash 2、二三档 3）」，
  // 所以这条从 ≤10% 放宽到 ≤13%。同时给危险档设上限，防止回到 2026-10-26
  // 被明确否掉的频率（那版 120 秒闪了 42 次、几乎每三秒一次，等于放弃输出）。
  ok('一档战斗位移占比 ≤13%（闪避加密后的上限）', moveShare <= 0.13, (moveShare * 100).toFixed(1) + '%')
  {
    const dTotal = Object.values(ACTION_WEIGHTS.fightDanger).reduce((a, b) => a + b, 0)
    const dMove = (ACTION_WEIGHTS.fightDanger.dash + ACTION_WEIGHTS.fightDanger.chase) / dTotal
    ok('危险档位移占比 ≤35%（闪避加密也不能变成不打）', dMove <= 0.35, (dMove * 100).toFixed(1) + '%')
  }
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
      pTier.decide({ motion: 0.3, combo: 1, hudKick: 0, hudBright: 0.08, progress: 0.5, hp: 0.93, shield: 0.10 }, { now: i * 300 })
    }
    const cs0 = pTier.combatStats
    ok('战斗帧会被计入遥测', cs0.frames >= 6, `frames=${cs0.frames}`)
    // 喂 0.93（满血实测 92.86% 取整），但基线上限是 0.92 —— 所以基线落在 0.92。
  // 这正好说明「物理上限」在起作用：污染帧再高也顶不上去。
  ok('基线取到了满血实测值（并被物理上限 0.92 夹住）', Math.abs(cs0.hpBaseline - 0.92) < 0.001 && Math.abs(cs0.shieldBaseline - 0.10) < 0.001,
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
  // 2026-10-31 改：读不到 HUD 时**要**计入「没进展」——
  //   在看不见的界面上空转不该被当成正常状态一直跑下去（死亡菜单/过场都算）。
  ok('没有 HUD 时会累积「没进展」，不会无限空转', p14.stillStreak > 0, String(p14.stillStreak))
  ok('启动阶段的确认键上限比游戏中宽', MAX_BOOT_INTERACTS > MAX_INTERACTS, `${MAX_BOOT_INTERACTS} vs ${MAX_INTERACTS}`)

  // ㉔ 输入法：中文模式下字母键和方向键会被输入法截给候选框，只剩 esc/enter 能进游戏。
  //    2026-10-27 实机踩到 —— 表现是「能开暂停菜单但完全不能移动」，看着像游戏锁了移动。
  //    修法：接上游戏时把该窗口线程的键盘布局切到英文。
  const imeBackend = fsSync.readFileSync(new URL('./lib/win-backend.mjs', import.meta.url), 'utf8')
  ok('后端有切英文布局的实现', /function ensureEnglishInput\(hwnd\)/.test(imeBackend), '缺 ensureEnglishInput')
  ok('后端注册了 englishinput 命令', /englishinput:\s*\(/.test(imeBackend), '缺 HANDLERS.englishinput')
  ok('切布局用 KLF_ACTIVATE 加载 00000409', /LoadKeyboardLayoutW\('00000409', 1\)/.test(imeBackend), '加载参数不对')
  ok('已经是英文时就短路', /before === 0x0409/.test(imeBackend), '缺短路')
  const imeHost = fsSync.readFileSync(new URL('./lib/host.mjs', import.meta.url), 'utf8')
  ok('后端客户端暴露 ensureEnglishInput', /async ensureEnglishInput\(hwnd\)/.test(imeHost), '缺客户端方法')
  const imeGame = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
  ok('接上游戏时会自动切英文', /await this\.wantEnglishInput\(\)/.test(imeGame), 'attach 里没调')
  ok('窗口变了会重新切英文', /if \(changed\) await this\.wantEnglishInput\(\)/.test(imeGame), 'ensureAttached 里没调')
  ok('attach 返回值里带 inputlang', /health: this\.health, inputlang/.test(imeGame), '返回值没带 inputlang')
  const imeAgent = fsSync.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
  ok('icey_start 的描述提到了输入法', /输入法/.test(imeAgent), '描述没提')
  const imeBook = fsSync.readFileSync(new URL('./lib/playbook.mjs', import.meta.url), 'utf8')
  ok('规则卡写了输入法这条坑', /先怀疑输入法/.test(imeBook), 'playbook hands 没写')
  ok('digest 也提了输入法', /输入法在中文模式/.test(imeBook), 'digest 没提')

  // ㉕ 后台战斗（2026-10-27）：目标是「它一直在打，我随时看一眼、拧一下」。
  //    三个实现支点是：工具层不 await、循环每步同步微调参数、停手/在场检查每步都查。
  const autoSrc = fsSync.readFileSync(new URL('./lib/autoplay.mjs', import.meta.url), 'utf8')
  ok('策略层导出 DEFAULT_ORDER', /export const DEFAULT_ORDER/.test(autoSrc), '')
  ok('策略层导出 normalizeOrder', /export function normalizeOrder/.test(autoSrc), '')
  ok('微调字段白名单只有 focus / style', /只认 focus \/ style/.test(autoSrc), '')
  ok('策略对象支持热更新参数', /setOrder\(patch = \{\}\) \{/.test(autoSrc), '')

  const autoMod = await import('./lib/autoplay.mjs')
  const polBg = autoMod.createPolicy('fight')
  ok('新策略默认 focus/style 都是 auto',
    polBg.order.focus === 'auto' && polBg.order.style === 'auto', JSON.stringify(polBg.order))
  ok('设 focus=left 立刻生效',
    polBg.setOrder({ focus: 'left' }).ok && polBg.order.focus === 'left', JSON.stringify(polBg.order))
  ok('非法 style 被拒', polBg.setOrder({ style: 'nope' }).ok === false, '')
  ok('未知字段被拒（不静默忽略）', polBg.setOrder({ foo: 1 }).ok === false, '')
  ok('normalizeOrder 是合并不是覆盖',
    autoMod.normalizeOrder({ style: 'steady' }, { focus: 'right', style: 'auto' }).order.focus === 'right', '')

  const bgGame = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
  ok('play 认 background 选项', /const background = opts\.background === true/.test(bgGame), '')
  ok('循环每步把微调参数同步给策略', /policy\.setOrder\(this\.bg\.order\)/.test(bgGame), '')
  ok('循环每步检查停手请求', /if \(this\.bg\.abortRequested\)/.test(bgGame), '')
  ok('后台战斗也守在场哨兵', /在场哨兵：模型已经/.test(bgGame) && /后台战斗自动停手/.test(bgGame), '')
  ok('有 setOrder 控制口', /^  setOrder\(patch = \{\}\) \{/m.test(bgGame), '')
  ok('有 requestStop 控制口', /^  requestStop\(\) \{/m.test(bgGame), '')
  ok('有 bgSnapshot 运行快照', /^  bgSnapshot\(\) \{/m.test(bgGame), '')
  ok('后台战斗时手工 act 被拒', /backgroundRunning: true/.test(bgGame), '')
  ok('status 带 background 字段', /background: this\.bgSnapshot\(\)/.test(bgGame), '')
  ok('dispose 会叫停后台战斗', /if \(this\.bg\) this\.bg\.abortRequested = true/.test(bgGame), '')

  const bgAgent = fsSync.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
  ok('工具层后台模式不 await（await 了模型就发不出 look）',
    /const p = s\.play\(\{/.test(bgAgent) && !/const p = await s\.play\(/.test(bgAgent), '')
  ok('工具层接住后台 promise 的失败（免得 unhandledRejection）', /p\.catch\(/.test(bgAgent), '')
  ok('icey_play 有 stop 参数', /stop: \{/.test(bgAgent), '')
  ok('icey_play 有 focus / style 参数', /focus: \{/.test(bgAgent) && /style: \{/.test(bgAgent), '')
  ok('icey_look 会显示后台战斗态', /后台战斗正在打/.test(bgAgent), '')
  ok('describeStatus 会显示后台战斗', /后台战斗进行中/.test(bgAgent), '')
  const bgBook = fsSync.readFileSync(new URL('./lib/playbook.mjs', import.meta.url), 'utf8')
  ok('规则卡写了「开一次就撒手」', /就撒手/.test(bgBook), '')
  ok('规则卡写明没有「撤退」选项', /没有「撤退」这个选项/.test(bgBook), '')
  ok('规则卡写明打不过也不脱战', /打不过也不脱战/.test(bgBook), '')

  // ㉖ 空战（2026-10-27 用户要求「加空战」，形态：跳起 → 空中 J 连 → 闪取消收尾）
  //    关键不是「写了三条字符串」，而是**这三条能真的被解析成按键序列** ——
  //    连段语法里 k=跳、o=闪、|=分阶段、x+y=按住方向点 J，写错一个字符就静默变成别的动作。
  {
    const { parseActionSpec: parseSpec, planAction: planAir } = await import('./lib/control.mjs')
    const airCombos = ['k|jjjj|o', 'k|jjj|o', 'w+j|jjj|o']
    ok('空连进了招式表', airCombos.every((c) => COMBOS.includes(c)),
      airCombos.filter((c) => !COMBOS.includes(c)).join(','))
    ok('空连都有非零权重', airCombos.every((c) => (COMBO_WEIGHTS[c] || 0) > 0),
      airCombos.map((c) => `${c}:${COMBO_WEIGHTS[c]}`).join(' '))
    // 逐条解析：跳 → 若干 J → 闪，三样都要在
    let airOk = true
    let airDetail = ''
    for (const c of airCombos) {
      const spec = parseSpec(`combo:${c}`)
      const steps = spec ? planAir(spec).steps || [] : []
      const labels = steps.map((s) => s.label).join('→')
      // 两种起手：k = 空格跳；w+j = ↑+J 激发（没有空格，标签是「按住 W…」）
      const startOk = c.startsWith('k|') ? /空格/.test(labels) : /按住 W/.test(labels)
      const endsWithDash = /O$/.test(labels)
      const jCount = (labels.match(/J/g) || []).length
      if (steps.length < 4 || !startOk || !endsWithDash || jCount < 3) {
        airOk = false
        airDetail = `${c} → ${labels || '(空)'}`
        break
      }
    }
    ok('空连能解析成「跳 → 至少 3 次 J → 闪」', airOk, airDetail)
    ok('闪避权重按用户要求加密（一档 2、二三档 3）',
      ACTION_WEIGHTS.fight.dash === 2 && ACTION_WEIGHTS.fightCautious.dash === 3 && ACTION_WEIGHTS.fightDanger.dash === 3,
      `${ACTION_WEIGHTS.fight.dash}/${ACTION_WEIGHTS.fightCautious.dash}/${ACTION_WEIGHTS.fightDanger.dash}`)
  }

  // ㉗ 「停手按了 Esc，但没人告诉我」（2026-10-28 从一轮实机复盘里查出来的）
  //    真相不是「没记」—— icey_play 早就渲染了 safetyPaused，是 **icey_auto 漏了**。
  //    于是用它停手的人接着发 move，全被暂停菜单吃掉（撞墙两次、白费半分钟）。
  {
    const fsA = fsSync.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')
    const iPlay = fsA.indexOf("name: 'icey_play'")
    const iAuto = fsA.indexOf("name: 'icey_auto'")
    const autoBody = fsA.slice(Math.min(iPlay, iAuto), Math.max(iPlay, iAuto))
    ok('icey_auto 也渲染 safetyPaused（不再只有 icey_play 有）', /safetyPaused/.test(autoBody), '')
    const pbSrc = fsSync.readFileSync(new URL('./lib/playbook.mjs', import.meta.url), 'utf8')
    ok('规则卡记了「死亡界面要按两次 Enter」', /死亡界面要按两次/.test(pbSrc), '')
    // 2026-10-29：menu:resume 已经自己连按两次，规则卡要说清「调一次就够」，
    // 否则模型看到截图还在菜单，会以为自己按错了、再调一次 —— 又白烧十秒。
    ok('规则卡说清 menu:resume 已替你连按两次（调一次就够）',
      /menu:resume/.test(pbSrc) && /连按两次/.test(pbSrc), '')

    // 疑似死亡回档（2026-10-29 用户纠正「钱变少是死亡回档」之后加的）
    // 插件此前**完全没有死亡信号**，HANDOFF 里「档位遥测在拿死过一次又满血的数据装懂」就是它。
    const deathEvSrc = fsSync.readFileSync(new URL('./lib/events.mjs', import.meta.url), 'utf8')
    const deathGmSrc = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
    const { KINDS: EV_KINDS } = await import('./lib/events.mjs')
    ok('事件表登记了 death-revive（否则事件层会当成拼错的 kind）',
      EV_KINDS.includes('death-revive'), EV_KINDS.join(','))
    ok('回档检测判据在：残血 → 血盾同时回高位',
      /death-revive/.test(deathGmSrc) && /wasLow/.test(deathGmSrc) && /nowHealthy/.test(deathGmSrc), '')
    ok('回档检测排除了处决回血（处决也会回血回盾）',
      /notExecuteHeal/.test(deathGmSrc) && /execAt/.test(deathGmSrc), '')
    ok('回档事件文案写明「疑似」+「别当赚的/花的」（插件读不到钱，不能替玩家下结论）',
      /疑似死亡回档/.test(deathGmSrc) && /存档点的数/.test(deathGmSrc), '')

    // 招式升级界面（2026-10-29 实测：它打开时血盾金钱都还在，所以「整屏界面」那条判据抓不到它）
    const { analyzeFrame: afUp, createPolicy: mkUp } = await import('./lib/autoplay.mjs')
    const { decodePng: decUp } = await import('./lib/png-decode.mjs')
    const upCases = [
      ['probe/fixtures/upgrade-menu.png', true, '强化界面（弥城死镇）'],
      ['probe/fixtures/station-fullframe.png', false, '普通游戏画面'],
      ['shots/watch/w0008.png', false, '暂停菜单'],
      ['probe/fixtures/ui-negative-death.png', false, '死亡画面'],
      ['shots/ui-neg/t1032.png', false, '地图列表'],
    ]
    for (const [p, want, label] of upCases) {
      if (!fsSync.existsSync(new URL(p, import.meta.url))) { ok(`${label}：样本缺失（跳过）`, true, p); continue }
      const im = decUp(fsSync.readFileSync(new URL(p, import.meta.url)))
      const r = afUp(im.rgba, im.width, im.height, null)
      ok(`强化界面判据：${label} → ${want ? '命中' : '不命中'}`,
        r.upgradeMenu === want, `upgradeMenu=${r.upgradeMenu} diag=${JSON.stringify(r.upgradeDiag)}`)
    }
    // 决策层：认出升级界面时**只按 Esc**，绝不在里面按 Enter（那是升级 ＝ 花钱）
    const pUp = mkUp('advance')
    const upActs = []
    for (let i = 0; i < 8; i++) {
      const d = pUp.decide({
        motion: 0.01, hudKick: 0, hudBright: 0.08,
        hp: 0.6, shield: 0.09, combo: 0, progress: 0.5,
        upgradeMenu: true, upgradeDiag: { dark: 0.84, demo: 122 },
      }, { now: i * 700 })
      upActs.push(d.action + (d.item ? ':' + d.item : ''))
    }
    ok('升级界面里只按 Esc（不按 Enter）',
      upActs.every((a) => a === 'menu:back' || a === 'wait'), upActs.join(','))
    ok('升级界面里没有 interact（Enter 在这里就是升级 ＝ 花钱）',
      !upActs.some((a) => a.startsWith('interact')), upActs.join(','))
    ok('升级界面里 Esc 有节流（8 帧里最多按 3 次，不然会连开暂停菜单）',
      upActs.filter((a) => a === 'menu:back').length <= 3, upActs.join(','))
    // 不在升级界面时，这条分支必须完全不干扰（否则每帧都按 Esc）
    const pNo = mkUp('advance')
    const noUp = pNo.decide({
      motion: 0.02, hudKick: 0, hudBright: 0.08, hp: 0.6, shield: 0.09, combo: 0, progress: 0.5,
      upgradeMenu: false,
    }, { now: 0 })
    ok('不是升级界面时不会按 Esc', noUp.action !== 'menu', JSON.stringify(noUp))

    // 战斗僵持三档（2026-10-29）：打不动要换打法，不是撤退、也不是原地耗到死
    const { createPolicy: mkStall, FIGHT_STALL_MS: STALL_MS, FIGHT_STALL_COOLDOWN_MS: STALL_CD } =
      await import('./lib/autoplay.mjs')
    ok('僵持判据的时长比「连击停滞」长（先翻面试错，再换真打法）',
      STALL_MS >= 3000 && STALL_MS <= 10000, 'STALL_MS=' + STALL_MS)
    const runStall = (withFoe) => {
      const p = mkStall('advance')
      const out = []
      for (let i = 0; i < 30; i++) {
        const m = {
          motion: 0.04, hudKick: 0, hudBright: 0.08,
          hp: 0.6, shield: 0.09, combo: 0.02, progress: 0.5,
        }
        if (withFoe) m.enemyDir = 'left'
        const d = p.decide(m, { now: i * 700 })
        out.push({ t: i * 0.7, action: d.action, dir: d.dir, keys: d.keys, why: d.why || '' })
      }
      return out
    }
    const stallActs = runStall(false)
    ok('僵持会触发「换站位」（dash），不是一直翻面',
      stallActs.some((a) => a.action === 'dash' && /僵持第 1 档/.test(a.why)),
      stallActs.filter((a) => a.action === 'dash').map((a) => a.t + 's').join(','))
    ok('僵持第 2 档会换成空中起手（k 起手的连段）',
      stallActs.some((a) => a.action === 'combo' && String(a.keys || '').startsWith('k|') && /僵持第 2 档/.test(a.why)),
      stallActs.filter((a) => /僵持第 2 档/.test(a.why)).map((a) => a.keys).join(','))
    ok('僵持第 3 档才翻面（位和招式都试过了）',
      stallActs.some((a) => a.action === 'face' && /僵持第 3 档/.test(a.why)), '')
    // 关键：用户 2026-10-27 定过「打不过也不脱战」。所以换位必须朝敌人，不能背离。
    const stallFoe = runStall(true)
    const dashes = stallFoe.filter((a) => a.action === 'dash' && /僵持第 1 档/.test(a.why))
    ok('僵持换位是朝敌人方向冲（不是撤退）',
      dashes.length > 0 && dashes.every((a) => a.dir === 'left'),
      dashes.map((a) => a.dir).join(','))
    // 不能抽搐：30 步（21 秒）里翻面次数要有上限
    const faceCount = stallActs.filter((a) => a.action === 'face').length
    ok('僵持 21 秒里翻面不超过 6 次（防止原地抽搐）', faceCount <= 6, 'face×' + faceCount)

    // 战斗屏障（2026-10-29）—— 用户报的那个「她判定那里过不去」的真正原因
    const { analyzeEnvironment: envBar } = await import('./lib/autoplay.mjs')
    {
      const dec = (await import('./lib/png-decode.mjs')).decodePng
      const barCases = [
        ['shots/ui-neg/barrier-174.png', true, '用户录像 2:54（右侧青色光幕）'],
        ['probe/fixtures/station-fullframe.png', false, '普通探索画面'],
        ['probe/fixtures/ui-negative-death.png', false, '死亡画面'],
      ]
      for (const [p, want, note] of barCases) {
        if (!fsSync.existsSync(new URL(p, import.meta.url))) { ok(`屏障：${note}（样本缺失，跳过）`, true, p); continue }
        const im = dec(fsSync.readFileSync(new URL(p, import.meta.url)))
        const e = envBar(im.rgba, im.width, im.height)
        ok(`屏障判据：${note} → ${want ? '认出' : '不误报'}`,
          e.barrier === want, `barrier=${e.barrier} 青度=${e.barrierEdge}`)
      }
      // 分析时帧会被缩到 ~480 宽，3% 只有 14px —— 必须确认缩小后信号还在
      const im0 = dec(fsSync.readFileSync(new URL('shots/ui-neg/barrier-174.png', import.meta.url)))
      const W2 = 480, H2 = Math.round((im0.height * W2) / im0.width)
      const small = new Uint8Array(W2 * H2 * 4)
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
        const si = (Math.floor((y * im0.height) / H2) * im0.width + Math.floor((x * im0.width) / W2)) * 4
        const di = (y * W2 + x) * 4
        small[di] = im0.rgba[si]; small[di + 1] = im0.rgba[si + 1]
        small[di + 2] = im0.rgba[si + 2]; small[di + 3] = 255
      }
      const eSmall = envBar(small, W2, H2)
      ok('屏障缩到 480 宽后仍认得出来（分析时就是这么缩的）',
        eSmall.barrier === true, `barrier=${eSmall.barrier} 青度=${eSmall.barrierEdge}`)
    }
    // 端到端：屏障亮着 + 连击区不亮 + 没刚掉血 ⇒ 必须算「在战斗」，不能判卡住
    {
      const srcGame = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
      ok('环境分析里的 barrier 真的被传给决策层（原来漏了这一行，那条判据从没生效）',
        /metrics\.barrier\s*=\s*env\.barrier/.test(srcGame), '')
      const pBar = mkUp('advance')
      const acts2 = []
      const whys2 = []
      for (let i = 0; i < 12; i++) {
        const d = pBar.decide({
          motion: 0.008, hudKick: 0, hudBright: 0.08,
          hp: 0.55, shield: 0.09, combo: 0, progress: 0.0,
          barrier: true,
        }, { now: i * 700 })
        acts2.push(d.action)
        whys2.push(d.why || '')
      }
      // 判「有没有走脱困阶梯」要看 why，不能看 action 名 —— dash/jump 在正常战斗里也用
      ok('屏障亮着时不走脱困阶梯（屏障锁着场地，不是路走不通）',
        !whys2.some((w) => /卡住|过不去|掉头|退一步/.test(w)),
        acts2.join(','))
      ok('屏障亮着时不会被判成「卡住」而去按确认键',
        !acts2.includes('interact'), acts2.join(','))
    }

    // 黄色箭头 = 敌人在那边（2026-10-29 用户指出：箭头在左、角色贴右边一直卡着）
    {
      const pFoe = mkUp('advance')
      const dirs = []
      const whys3 = []
      for (let i = 0; i < 16; i++) {
        const d = pFoe.decide({
          motion: 0.02, hudKick: 0, hudBright: 0.08,
          hp: 0.55, shield: 0.09, combo: 0.02, progress: 0,
          enemyDir: 'left', barrier: true,
        }, { now: i * 700 })
        whys3.push(`${d.action}${d.dir ? ':' + d.dir : ''} | ${d.why || ''}`)
        if (d.dir) dirs.push(d.dir)
      }
      ok('敌人在左边时，所有带方向的移动都朝左（不会往反方向挪）',
        dirs.length > 0 && dirs.every((x) => x === 'left'), [...new Set(dirs)].join(','))
      ok('敌人在左边时会先走过去接战，而不是原地打空气',
        whys3.some((w) => /敌人在画面外，走过去接战/.test(w)), '')
      ok('箭头指着敌人时不会翻面背对它（原来会 face:left→face:right 来回抽）',
        !whys3.some((w) => /翻面向右|翻面向左/.test(w)), '')
      // 反过来验：没有箭头时「连击不涨就翻面」这条老功能不能被弄丢
      const pNoFoe = mkUp('advance')
      let flipped = false
      for (let i = 0; i < 12; i++) {
        const d = pNoFoe.decide({
          motion: 0.02, hudKick: 0, hudBright: 0.08,
          hp: 0.55, shield: 0.09, combo: 0.02, progress: 0.5,
        }, { now: i * 700 })
        if (d.action === 'face') flipped = true
      }
      ok('没有箭头时，「连击不涨就翻面」仍然有效', flipped, '')
    }

    // 断连原因分类（2026-10-30 用户补的游戏机制）
    //   连击数在「一段时间没打中 / 破盾后受击 / 受击」三种情况下都会消失。
    //   后两种都在战斗里 ⇒ 「连击没了」不能当成「打空了」。
    {
      const stallRun = (hpAt, secs, opts = {}) => {
        const p = mkUp('advance')
        const out = []
        for (let i = 0; i < secs; i++) {
          out.push(p.decide({
            motion: 0.02, hudKick: 0, hudBright: 0.08,
            hp: hpAt(i * 0.7),
            shield: opts.shieldAt ? opts.shieldAt(i * 0.7) : 0.09,
            combo: 0, progress: 0, enemyDir: 'left',
            barrier: opts.barrier !== false,
          }, { now: i * 700 }))
        }
        return out.filter((d) => /僵持第/.test(d.why || ''))
      }
      ok('连击断了但血盾没动 ⇒ 判打空，换打法',
        stallRun(() => 0.55, 10).length > 0, '')
      ok('连击断了但血在掉 ⇒ 判挨打，不换位（换位只会离敌人更远）',
        stallRun((t) => Math.max(0.2, 0.70 - t * 0.02), 10).length === 0, '')
      ok('破盾后受击（盾先掉）也算挨打，不换位',
        stallRun((t) => Math.max(0.3, 0.70 - t * 0.008), 10,
          { shieldAt: (t) => Math.max(0, 0.09 - t * 0.04) }).length === 0, '')
      ok('不在战斗时不会触发僵持（连击消失不等于在战斗）',
        stallRun(() => 0.55, 10, { barrier: false }).length === 0, '')
      ok('但挨打超过 12 秒还打不中就还是要换打法（已经不是稳阵脚的问题了）',
        stallRun((t) => Math.max(0.2, 0.70 - t * 0.004), 20).length > 0, '')
    }
    // 打不中就沿地面扫过去（2026-10-30）
    //   起因：2422 秒录像里有整段「屏障亮着 + 连击 0%」，最长 55 秒，
    //   她贴着屏障一下一下朝空气挥 —— 战斗分支当时没有任何一条会真的走过去。
    {
      const sweepRun = (opts, secs) => {
        const p = mkUp('advance')
        const out = []
        for (let i = 0; i < secs; i++) {
          out.push(p.decide({
            motion: 0.02, hudKick: 0, hudBright: 0.08,
            hp: 0.55, shield: 0.09, combo: 0, progress: 0,
            barrier: opts.barrier !== false,
            ...(opts.enemyDir ? { enemyDir: opts.enemyDir } : {}),
          }, { now: i * 700 }))
        }
        return out
      }
      const run = sweepRun({}, 20)
      const sweeps = run.filter((d) => /沿地面往/.test(d.why || ''))
      ok('连击消失、血盾没掉、也没有箭头 ⇒ 会朝前走一段（不再原地挥空气）',
        sweeps.length > 0, run.slice(0, 6).map((d) => d.action).join(','))

      // 走的方向不能每 1.2 秒掉一次头（那还是原地抽搐，只是换了个动作名）
      const sweepDirs = sweeps.map((d) => d.dir).filter(Boolean)
      let flips = 0
      for (let i = 1; i < sweepDirs.length; i++) if (sweepDirs[i] !== sweepDirs[i - 1]) flips++
      ok('扫场地时换边有节奏（14 秒里换向 2~8 次，不是每拍都掉头）',
        flips >= 2 && flips <= 8, `换向 ${flips} 次 / 扫步 ${sweepDirs.length} 次`)
      ok('扫场地会两边都走到（不会一直朝同一边撞墙）',
        new Set(sweepDirs).size === 2, [...new Set(sweepDirs)].join(','))

      // 有箭头时不能扫 —— ①-a 已经朝那边走了，再扫就是反着来
      ok('知道敌人在哪边时不会盲扫（不会和「走过去接战」对着干）',
        sweepRun({ enemyDir: 'left' }, 20).every((d) => !/沿地面往/.test(d.why || '')), '')
      // 不在战斗时也不扫（这条只在战斗分支里）
      ok('不在战斗时不扫（探索另有探索的节奏）',
        sweepRun({ barrier: false }, 20).every((d) => !/沿地面往/.test(d.why || '')), '')
    }

    // 低血闪避不许变成逃跑（2026-10-30 实测：测试会话 3 轮里「低血：闪开」出现 18 次，
    //   血量掉到 11.4%、最长 58 秒一次没打中 —— 因为闪完就背对敌人接着砍空气）
    {
      const pPanic = mkUp('advance')
      const acts = []
      for (let i = 0; i < 28; i++) {
        // 血一直很低（10/62 ≈ 16%），敌人一直在右边
        acts.push(pPanic.decide({
          motion: 0.02, hudKick: 0, hudBright: 0.08,
          hp: 0.10, shield: 0.02, combo: 0, progress: 0,
          enemyDir: 'right', barrier: true,
        }, { now: i * 700 }))
      }
      const dodges = acts.filter((d) => /低血：闪开/.test(d.why || ''))
      const refaces = acts.filter((d) => /刚闪完/.test(d.why || ''))
      ok('低血闪避之后会转回去（不会背对敌人一直砍空气）',
        refaces.length > 0 && refaces.every((d) => d.dir === 'right'),
        `闪 ${dodges.length} 次 / 转回 ${refaces.length} 次`)
      ok('低血闪避有上限（连闪三次就收手先打 6 秒，不会整场只剩闪）',
        dodges.length <= 12,
        `28 拍里闪了 ${dodges.length} 次`)
    }

    // 回归：战斗里的移动注入原来写的是 `foeDir || dir`，而 dir 是探索方向（一直是 right）。
    // 按本文件自己写下的机制「朝向 = 最后一次移动方向」，那等于每 7 拍把她掰回朝右、
    // 还顺带推向右边 —— 用户看到的「一直卡在右边」就是这么来的。
    {
      const apSrcForMove = fsSync.readFileSync(new URL('./lib/autoplay.mjs', import.meta.url), 'utf8')
      const combatMoveSrc = (apSrcForMove.match(/action: '(chase|dash)', dir: foeDir \|\| (\w+)/g) || [])
      ok('战斗里的移动注入用跟踪到的朝向（facing），不用探索方向（dir）',
        combatMoveSrc.length >= 1 && combatMoveSrc.every((s) => /facing$/.test(s)),
        combatMoveSrc.join(' / '))
    }

    ok('规则卡里强化台键位以提示框为准（不写死空格/Enter）',
      /以提示框写的键为准/.test(pbSrc) || /以提示框.*为准/.test(pbSrc), '')
    // 2026-10-29：接上游戏时顺手给规则卡精华，新会话不用先单独调一次 icey_playbook
    ok('icey_start 会带上规则卡精华（省掉一次 playbook 往返）',
      /规则卡精华/.test(fsA) && /PLAYBOOK\.digest/.test(fsA), '')
    // 2026-10-29 实测：**窗口不在前台时切布局无效**（切完还 0x804，方向键照旧被吞）。
    // 所以切失败必须抢一次前台重切 —— 否则「自动切英文」只在理想条件下成立。
    const gmSrc = fsSync.readFileSync(new URL('./lib/game.mjs', import.meta.url), 'utf8')
    ok('切英文失败时会抢前台重试（不在前台时切不生效）',
      /retriedAfterFocus/.test(gmSrc) && /backend\.focus\(this\.hwnd\)/.test(gmSrc), '')
    ok('规则卡写明「自动切英文要求游戏在前台」',
      /要求游戏窗口在前台|不在前台时自动切不生效/.test(pbSrc), '')
    // 分段托管的两条硬约束（2026-10-31 实测得来）：
    //   ① 段末必须**先抓帧再按 Esc** —— 暂停后所有判据读 0.00%（实测），反了就只剩压暗图
    //   ② 下一段开始要自己从暂停菜单恢复，否则会在菜单里瞎跑一整段
    {
      const iGrab = gmSrc.indexOf('checkpointShot = {')
      const iNeed = gmSrc.indexOf('const needPause')
      const iEsc = gmSrc.indexOf("await this.backend.keydown('Escape')", iNeed)
      ok('段末暂停：先抓帧、再按 Esc（顺序反了读数就全归零）',
        iGrab > 0 && iEsc > iGrab, `抓帧@${iGrab} Esc@${iEsc}`)
      ok('段末暂停：开跑前会检查是否卡在暂停菜单',
        /pausedByPlugin/.test(gmSrc) && /inMenu/.test(gmSrc), '')
      ok('段末暂停：play() 认 pauseAtEnd 这个选项', /const pauseAtEnd = !!opts\.pauseAtEnd/.test(gmSrc), '')
    }
    // 2026-10-29 实测：一整局没满过血 → 基线学到 0.321 → 19.6% 报成 60.8%、残血判健康。
    const apSrc = fsSync.readFileSync(new URL('./lib/autoplay.mjs', import.meta.url), 'utf8')
    ok('血基线有托底（没满过血也不会被学得太低）',
      /const HP_BASELINE_FLOOR = [0-9.]+/.test(apSrc)
      && /hpBaseline < HP_BASELINE_FLOOR\) hpBaseline = HP_BASELINE_FLOOR/.test(apSrc), '')
    ok('连击区峰值/上涨次数有记录（分辨打中 vs 空挥）',
      /comboPeak/.test(apSrc) && /comboGains/.test(apSrc), '')
  }
}

/* ---------- 汇总 ---------- */
console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 项通过，${fails.length} 项失败`)
if (fails.length) {
  for (const f of fails) console.log(`   - ${f}`)
  process.exit(1)
}

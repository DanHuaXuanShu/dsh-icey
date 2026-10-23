/**
 * dsh-icey —— 宿主半：配置 + 路由（面板实时画面 / 状态 / 动作）
 * ============================================================================
 * 这个文件只做三件事：
 *   1. 声明 Config（每个字段 .extra('volatile', true)，设置页改完不用重启）
 *   2. 注册 /api/dsh-icey/* 路由（面板和外部都能用；SSE 送实时画面）
 *   3. 卸载时松键、关 worker（绝不留卡住的键）
 * 给模型用的工具在 agent.js（另一行插件），两边共用 lib/session.mjs 的同一个 GameSession。
 *
 * 🔴 三条实测约束（写代码前先看这段，别踩回去）：
 *   ① 按键只能 SendInput，且游戏必须在前台 —— ICEY 完全无视 PostMessage。
 *      抢前台会打断用户正在干的事 ⇒ allowFocus 可关，且状态里如实写。
 *   ② 抓帧必须 PrintWindow(PW_RENDERFULLCONTENT)；最小化时抓不到。
 *   ③ 抓帧 + 颜色转换 + 缩放都在 worker 线程里做，主线程只转手 Buffer。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { loadOverrides, saveOverrides, configPath } from './lib/store.mjs'
import { configure, session, shutdown } from './lib/session.mjs'
import { normalizeConfig, DEFAULTS, exePathOf } from './lib/config.mjs'
import { planAction, ACTION_SPECS, DEFAULT_KEYMAP } from './lib/control.mjs'
import { apply as applyAgentHalf } from './agent.js'

export const name = 'dsh-icey'
// 只用 connection（路由）。**不**注入 subprocess：那个服务会把它管理的进程在卸载时终止，
// 拿它启动游戏 ⇒ 插件一重载就把用户的游戏杀了。启动游戏用 detached spawn（见下）。
// agent 半（6 个工具）的 tools / attachments 也不写在这里 —— 见文件末尾那段说明：
// 用 ctx.get() 探测，缺服务就只跳过工具，不让整条插件不激活。
export const inject = ['connection']

const hostDeps = await loadHostDeps()
const z = hostDeps.z

/** 每个字段都必须 volatile：DSH 的 settings.update() 只认 volatile 字段 */
export const Config = !z ? undefined : z.object({
  gameDir: z.string().default(DEFAULTS.gameDir)
    .description('《艾希》的游戏目录（有 ICEY.exe 的那一层）').extra('volatile', true),
  exePath: z.string().default('')
    .description('直接指定 ICEY.exe 的完整路径；留空就用 游戏目录\\ICEY.exe').extra('volatile', true),
  steamAppId: z.string().default(DEFAULTS.steamAppId)
    .description('Steam 上的 AppID（艾希是 553640）').extra('volatile', true),
  launchMode: z.union(['attach', 'steam', 'direct']).default('attach')
    .description('怎么开游戏：attach=接上已经开着的窗口（推荐）/ steam=让 Steam 启动 / direct=直接跑 exe').extra('volatile', true),
  fps: z.natural().default(10)
    .description('面板实时画面的帧率（1–12；再高对看画面没意义，只是烧 CPU）').extra('volatile', true),
  streamWidth: z.natural().default(960)
    .description('面板画面宽度（320–1280）。越小越省 CPU；960 已经能看清角色和血条').extra('volatile', true),
  inputBackend: z.union(['sendinput', 'postmessage']).default('sendinput')
    .description('按键方式。实测 ICEY 只认 sendinput；postmessage 留作排查用（发了也不动）').extra('volatile', true),
  captureMode: z.union(['printwindow', 'bitblt']).default('printwindow')
    .description('抓帧方式：printwindow 能抓 D3D 窗口（推荐）；bitblt 只在前者失败时试').extra('volatile', true),
  koffiPath: z.string().default('')
    .description('koffi 的 package.json 路径；留空自动从 DSH profile 里找').extra('volatile', true),
  allowFocus: z.boolean().default(true)
    .description('操作时自动把游戏窗口抢到前台。ICEY 只接受前台按键，所以关掉它就只能看不能动').extra('volatile', true),
  restoreFocus: z.boolean().default(true)
    .description('动作做完把焦点还给原来的窗口（建议开着，否则玩一会儿 DSH 就一直被游戏压着）').extra('volatile', true),
  windowedFix: z.boolean().default(true)
    .description('direct 启动时加窗口化参数（全屏也能跑，但窗口化更容易抓帧和切窗口）').extra('volatile', true),
  maxFrameWidth: z.natural().default(1280)
    .description('给模型看的截图宽度上限（像素；越大越清楚也越费 token）').extra('volatile', true),
})

/**
 * 现读配置。三层合并，优先级从高到低：
 *   ① DSH 设置页的 volatile Cell（能取到就用它）
 *   ② $DSH_HOME/icey/config.json（面板和 /config PATCH 写这份）
 *   ③ lib/config.mjs 的 DEFAULTS
 * 为什么要有 ②：这台机器的 profile 树里没有 schemastery，Config 是 undefined，
 * DSH 设置页就没有字段可改 —— 没有 ② 的话用户根本没法调配置。
 */
function readConfig(config) {
  const overrides = loadOverrides()
  const pick = (key, fallback) => {
    const cell = config?.[key]
    if (cell && typeof cell.get === 'function') {
      const v = cell.get()
      if (v !== undefined) return v
    }
    if (overrides[key] !== undefined) return overrides[key]
    return fallback
  }
  return normalizeConfig({
    gameDir: pick('gameDir', DEFAULTS.gameDir),
    exePath: pick('exePath', DEFAULTS.exePath),
    steamAppId: pick('steamAppId', DEFAULTS.steamAppId),
    launchMode: pick('launchMode', DEFAULTS.launchMode),
    fps: pick('fps', DEFAULTS.fps),
    streamWidth: pick('streamWidth', DEFAULTS.streamWidth),
    inputBackend: pick('inputBackend', DEFAULTS.inputBackend),
    captureMode: pick('captureMode', DEFAULTS.captureMode),
    koffiPath: pick('koffiPath', DEFAULTS.koffiPath),
    allowFocus: pick('allowFocus', DEFAULTS.allowFocus),
    restoreFocus: pick('restoreFocus', DEFAULTS.restoreFocus),
    windowedFix: pick('windowedFix', DEFAULTS.windowedFix),
    maxFrameWidth: pick('maxFrameWidth', DEFAULTS.maxFrameWidth),
    keyMap: overrides.keyMap,
  })
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const bad = (message, status = 400) => json({ ok: false, error: message }, status)

export function apply(ctx, config = {}) {
  const log = (msg) => {
    try { ctx.logger?.info?.(msg) } catch { /* 没有 logger 也能跑 */ }
  }
  for (const note of hostDeps.notes) log(`[icey] ${note}`)

  /**
   * 启动游戏。用 node 的 detached spawn，**不用** ctx.subprocess：
   * subprocess 服务在卸载时会终止它管理的所有进程 —— 插件一重载就把用户的游戏杀了。
   * detached + unref ⇒ 游戏活在自己的进程组里，插件卸载、DSH 关掉都不影响它。
   */
  const spawnProcess = async (spec) => {
    const child = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: spec.env || process.env,
    })
    child.unref()
    log(`[icey] 已启动：${spec.command} ${(spec.args || []).join(' ')}`)
    return { pid: child.pid }
  }

  configure({ getConfig: () => readConfig(config), spawnProcess, log })

  // 卸载/重载：松键 + 关 worker（这条必须留着，否则重载后键可能卡在按下状态）
  ctx.effect(() => () => { void shutdown('plugin unload') }, 'dsh-icey shutdown')

  const route = (path, methods, fetch, label) =>
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), label)

  const body = async (request) => {
    try { return await request.json() } catch { return {} }
  }

  /* ---------------- 状态 ---------------- */

  route('/api/dsh-icey/status', ['GET'], async () => {
    try {
      const s = session()
      const st = await s.status()
      return json({
        ok: true,
        ...st,
        // 面板要显示的东西：能做什么、不能做的原因
        canAct: !!st.health?.playable,
        actions: Object.entries(ACTION_SPECS).map(([k, v]) => ({ action: k, args: v.args, desc: v.desc })),
        keys: DEFAULT_KEYMAP,
        exe: exePathOf(readConfig(config)),
      })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey status')

  route('/api/dsh-icey/health', ['GET'], async () => {
    try {
      const st = await session().status()
      return json({
        ok: true,
        running: st.running,
        playable: !!st.health?.playable,
        reason: st.health?.reason || null,
        foreground: st.health?.foreground ?? null,
        minimized: st.minimized ?? null,
        windowAlive: st.windowAlive ?? null,
        backend: st.backend,
      })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey health')

  /* ---------------- 启动 / 接入 ---------------- */

  route('/api/dsh-icey/launch', ['POST'], async (request) => {
    const b = await body(request)
    const cfg = readConfig(config)
    try {
      const s = session()
      const launched = await s.launch(b.mode)
      if (launched.attached) return json({ ok: true, ...launched })
      // attach 模式没接上 = 游戏根本没在跑。**立刻说清楚**，
      // 绝不能掉进下面的 waitForWindow 白等 60 秒（那就是「点了没反应」）。
      if (launched.launched === false) {
        return json({
          ok: false,
          attached: false,
          mode: launched.mode || 'attach',
          error: launched.reason || '没找到正在运行的《艾希》',
          hint: `游戏没开着。用 mode=direct 直接启动（${cfg.gameDir}\\ICEY.exe），或者 mode=steam 让 Steam 启动。`,
        })
      }
      const waited = await s.waitForWindow(Number(b.waitMs) || 60_000)
      if (!waited.ok) {
        return json({
          ok: false,
          launched: true,
          error: waited.reason,
          hint: `游戏启动后窗口没出现。检查 ${cfg.gameDir}\\output_log.txt 里的报错；或者干脆手动开游戏，再用 launchMode=attach 接上。`,
        })
      }
      return json({ ok: true, ...launched, attached: true, ...waited })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey launch')

  route('/api/dsh-icey/attach', ['POST'], async () => {
    try {
      const res = await session().attach()
      return json({ ok: true, ...res })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey attach')

  /* ---------------- 动作 ---------------- */

  route('/api/dsh-icey/act', ['POST'], async (request) => {
    const b = await body(request)
    try {
      const res = await session().act(
        { action: b.action, dir: b.dir, ms: b.ms, item: b.item },
        { withDiff: !!b.diff },
      )
      return json(res)
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey act')

  route('/api/dsh-icey/keys', ['POST'], async (request) => {
    const b = await body(request)
    if (!Array.isArray(b.sequence)) return bad('sequence 必须是 [{key, up?, ms?}] 数组')
    try {
      const res = await session().keys(b.sequence)
      return json(res)
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey keys')

  route('/api/dsh-icey/release', ['POST'], async () => {
    try {
      const released = await session().releaseAll()
      return json({ ok: true, released })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey release')

  /* ---------------- 单帧（PNG，给不想开 SSE 的地方用） ---------------- */

  route('/api/dsh-icey/frame', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const maxWidth = Number(params.get('w')) || 0
    try {
      const s = session()
      const frame = maxWidth ? await s.look({ maxWidth }) : await s.lookRaw()
      const png = maxWidth ? frame.png : (await import('./lib/vision.mjs')).toPng(frame)
      return new Response(png, {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      })
    } catch (e) {
      return bad(String(e?.message || e), 503)
    }
  }, 'dsh-icey frame')

  /* ---------------- 实时画面（二进制帧流） ---------------- */

  /**
   * 面板实时画面。**不用 SSE/base64**，直接推二进制帧：
   *   每帧 = 16 字节头 + 原始 RGBA
   *     0..4   magic 'ICYF'（或 'ICYE' = 错误帧，后面跟 UTF-8 错误文本）
   *     4..8   uint32 width
   *     8..12  uint32 height
   *    12..16  uint32 byteLength
   *   然后 byteLength 字节的 RGBA。
   *
   * 🔴 为什么不用 SSE：一帧原始 1606x935 是 6MB，base64 + 拼字符串 + UTF-8 编码
   * 实测 147ms/秒（10fps）全压在宿主主线程上，浏览器那边 atob + 逐字节复制还要
   * 41ms/帧 ⇒ DSH 整个 Web GUI 卡死，用户看到的就是「插件一开艾希，dsh 就不能用了」。
   * 二进制帧没有这些开销：主线程只是把 Buffer 塞进 stream，浏览器直接
   * new Uint8ClampedArray → putImageData。
   *
   * 拉模式 + 背压：用 ReadableStream 的 pull，浏览器不消费就不抓帧（CPU 归零）。
   * 抓帧自适应间隔：一帧花多久，下一帧就等多久（至少 minGap），绝不堆积。
   */
  route('/api/dsh-icey/stream', ['GET'], (request) => {
    const params = new URL(request.url).searchParams
    const s = session()
    const cfg = readConfig(config)
    const fps = Math.min(12, Math.max(1, Number(params.get('fps')) || cfg.fps))
    const width = Math.min(1280, Math.max(320, Number(params.get('w')) || cfg.streamWidth))
    const minGap = Math.floor(1000 / fps)
    let closed = false
    let timer = null
    let viewerDropped = false

    s.addViewer()
    const drop = () => {
      if (viewerDropped) return
      viewerDropped = true
      if (timer) { clearTimeout(timer); timer = null }
      s.removeViewer()
    }

    const frameHead = (magic, w, h, len) => {
      const b = Buffer.allocUnsafe(16)
      b.write(magic, 0, 'ascii')
      b.writeUInt32LE(w, 4)
      b.writeUInt32LE(h, 8)
      b.writeUInt32LE(len, 12)
      return b
    }

    const stream = new ReadableStream({
      async pull(controller) {
        if (closed) return
        const t0 = Date.now()
        let frame = null
        let failure = ''
        try {
          frame = await s.captureStreamFrame(width)
        } catch (e) {
          failure = String(e?.message || e)
        }
        if (closed) return
        try {
          if (frame) {
            // Buffer 本身就是 Uint8Array，直接入队 —— 别再拷贝一份 2MB
            controller.enqueue(frameHead('ICYF', frame.width, frame.height, frame.rgba.length))
            controller.enqueue(frame.rgba)
          } else {
            // 错误帧：面板能把原因显示出来，而不是白屏
            const msg = Buffer.from(failure || '抓帧失败', 'utf8')
            controller.enqueue(frameHead('ICYE', 0, 0, msg.length))
            controller.enqueue(msg)
          }
        } catch {
          drop()
          closed = true
          try { controller.close() } catch { /* 已经关了 */ }
          return
        }
        // 自适应：抓帧比目标间隔慢就自动放宽（1.25 倍余量），绝不堆积；
        // 抓帧很快时以 minGap 为准，不会超过用户设的帧率。
        const spent = Date.now() - t0
        const gap = Math.max(minGap, Math.min(2000, Math.round(spent * 1.25)))
        const wait = Math.max(0, gap - spent)
        if (wait > 0) {
          await new Promise((r) => { timer = setTimeout(r, wait) })
          timer = null
        }
      },
      cancel() {
        closed = true
        drop()
      },
    })

    // 连接断了但 pull 没再被叫到时，靠 abort 兜底回收观看者计数
    try { request.signal?.addEventListener?.('abort', () => { closed = true; drop() }) } catch { /* 没 signal */ }

    return new Response(stream, {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-icey-frame-format': 'ICYF/16+rgba',
      },
    })
  }, 'dsh-icey stream')

  /* ---------------- 规则卡（模型需要时来取，不占每一步的 token） ---------------- */

  route('/api/dsh-icey/playbook', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const { PLAYBOOK, playbookText } = await import('./lib/playbook.mjs')
    if (params.get('format') === 'compact') return json({ ok: true, digest: PLAYBOOK.digest })
    return new Response(playbookText(), {
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
    })
  }, 'dsh-icey playbook')

  /* ---------------- 配置读写（面板不用 DSH 设置页也能改） ---------------- */

  // ⚠️ 同一个 path 只能注册一次（第二次会报 "exact Fetch route is already registered"），
  //    所以 GET 和 PATCH 合成一个 handler，按 request.method 分支。
  route('/api/dsh-icey/config', ['GET', 'PATCH'], async (request) => {
    if (request.method === 'GET') {
      return json({
        ok: true,
        config: readConfig(config),
        defaults: DEFAULTS,
        // 让面板能说明「改的东西存哪了」
        storage: { path: configPath(), overrides: Object.keys(loadOverrides()) },
      })
    }
    const patch = await body(request)
    // 面板/脚本改配置：校验后持久化到 $DSH_HOME/icey/config.json，不用重启就生效
    try {
      const merged = normalizeConfig({ ...readConfig(config), ...patch })
      // 只存用户真的传了的字段（别把整套默认值烤进文件，以后改默认值就失效了）
      const toSave = {}
      for (const k of Object.keys(patch)) {
        if (merged[k] !== undefined) toSave[k] = merged[k]
      }
      const saved = saveOverrides(toSave)
      if (!saved.ok) return json({ ok: false, error: `配置没存下来：${saved.error}`, config: merged })
      return json({ ok: true, config: merged, savedTo: saved.path, changed: Object.keys(toSave) })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey config')

  /* ---------------- 调试：看看这个键算出来的动作是什么 ---------------- */

  route('/api/dsh-icey/plan', ['POST'], async (request) => {
    const b = await body(request)
    try {
      const plan = planAction({ action: b.action, dir: b.dir, ms: b.ms, item: b.item }, { keyMap: readConfig(config).keyMap })
      return json({ ok: true, plan })
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) })
    }
  }, 'dsh-icey plan')

  log('[icey] 宿主半就绪：/api/dsh-icey/{status,health,launch,attach,act,keys,release,frame,stream,config,plan}')

  /* ---------------- 顺带把 agent 半的工具也注册上 ---------------- */

  /**
   * 🔴 为什么不再单独占一行插件（2026-10-22 改）：
   *   以前 cordis.patch.yml 插了两行（`dsh-icey` + `dsh-icey/agent`），
   *   结果插件列表里出现**两个标题完全相同的「艾希 ICEY」条目**。
   *   原因在宿主：行的标题取 `row.meta?.title ?? row.moduleName`，而
   *   `metaOf()` 是按**包**取 locale 的 `meta.title` —— 两行同一个包，
   *   自然同一个标题。行名 `dsh-icey/agent` 只能作为副标题出现。
   *
   * 现在合成一行。工具用 **`ctx.inject(['tools','attachments'], ...)`** 注册：
   *   - 这不是普通依赖声明，而是**可选依赖**：那两个服务出现时才执行回调，
   *     不会阻塞本插件自己的激活 ⇒ 缺服务的部署只是没有工具，面板/路由照常。
   *   - 也别改成 `ctx.get('tools')` 探测：Cordis 的 inject 同时负责**激活顺序**，
   *     光 get 有可能在 tools 服务注册之前就探测，导致工具静默不注册（踩过）。
   */
  const registerTools = (sub) => {
    const target = sub || ctx
    if (!target?.tools?.register || !target?.attachments) {
      log('[icey] 没有 tools/attachments 服务 ⇒ 跳过 icey_* 工具（面板和路由照常可用）')
      return
    }
    try {
      // agent.js 的 apply 是同步的（只调 ctx.tools.register）
      applyAgentHalf(target)
      log('[icey] agent 半就绪：8 个 icey_* 工具已注册')
    } catch (e) {
      // 工具注册失败不能连累面板/路由
      log(`[icey] agent 半注册失败（工具不可用，面板照常）：${e?.message || e}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    // 可选依赖：服务齐了才回调，不齐就永远不调 —— 本插件照样激活。
    // 这条日志**无条件**打，这样「工具没出现」时能立刻看出是等在等服务，而不是莫名消失。
    log('[icey] 8 个 icey_* 工具将以可选依赖方式注册（等 tools + attachments 就绪）')
    ctx.inject(['tools', 'attachments'], (sub) => registerTools(sub))
  } else {
    // 老版本 Cordis 没有动态 inject：退化成即时探测（可能因顺序而跳过）
    registerTools(ctx)
  }
}

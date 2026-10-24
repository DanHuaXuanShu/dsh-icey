/**
 * lib/game.mjs —— 游戏会话编排：找窗口 / 启动 / 动作队列 / 帧广播 / 状态
 * ============================================================================
 * 这一层是插件的「大脑」，路由和工具都调它，它自己不认识 HTTP 也不认识 defineTool。
 *
 * 🔴 三条硬约束（都是实测出来的，不是猜的）：
 *   1. **按键只能走 SendInput，且游戏必须在前台。** ICEY 完全无视 PostMessage
 *      （前台发、后台发都试过，画面一动不动）。所以「操作」= 抢前台 + SendInput。
 *      抢前台会影响用户正在干的事 ⇒ 必须可关（allowFocus），且要如实告诉用户。
 *      ⚠️ 反过来的坑：**ICEY 自己也会抢焦点**（实测它会把前台抢回去）。所以不能假设
 *      「刚才抢到了，现在还在前台」，每次动手前都要重新确认。
 *   2. **抓帧走 PrintWindow(PW_RENDERFULLCONTENT)。** Unity/D3D 窗口用普通 BitBlt
 *      会抓到黑屏；最小化时两种都抓不到（不过游戏大约 15 秒会自己把窗口还原）。
 *   3. **任何时候都不能留卡住的键。** 动作异常、面板断开、插件卸载、看门狗超时，
 *      四条路都要 releaseAll。
 * ============================================================================
 */
import { NativeBackend } from './host.mjs'
import { existsSync } from 'node:fs'
import { ActionQueue, planAction } from './control.mjs'
import { normalizeConfig, exePathOf, WINDOWED_ARGS } from './config.mjs'
import { grabFrame, assessPlayability, ensureForeground, restoreForeground, toPng } from './vision.mjs'
import { frameHash, diffRatio, cropRgba, encodePng } from './png.mjs'
import { EventLog } from './events.mjs'
import { previousRun, saveRun } from './run-history.mjs'
import { analyzeFrame, analyzeEnvironment, createChestTracker, createPolicy, PRESETS, summarizeRun } from './autoplay.mjs'
// 「游戏无响应」检测：画面连续多帧一个像素都不变、而这期间我们又按过键 → 不是卡住，是游戏死了。
// 来龙去脉见 lib/ui/frame-print.mjs 顶部注释（2026-10-24 连玩时真的卡死过）。
import { createFreezeDetector } from './ui/frame-print.mjs'
import { findGuideArrow } from './ui/guide-arrow.mjs'
import { findExecuteKeycap } from './ui/execute-keycap.mjs'

/** 看门狗：一次动作最多占这么久，超时就强制松键 */
const ACTION_TIMEOUT_MS = 8000
/** 面板帧率的心跳间隔（SSE ping） */
const PING_MS = 15_000

export class GameSession {
  /**
   * @param {object} opts
   * @param {() => Record<string,any>} opts.getConfig 每次现读配置（支持热改）
   * @param {(spec: object) => any} [opts.spawnProcess] 启动进程用（由 index.js 注入 ctx.subprocess）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.getConfig = opts.getConfig
    this.spawnProcess = opts.spawnProcess || null
    this.log = opts.log || (() => {})
    this.backend = null
    this.hwnd = 0
    this.pid = 0
    this.startedAt = 0
    this.lastFrameAt = 0
    this.lastHash = ''
    this.lastError = ''
    this.launchInfo = null
    this.viewers = 0
    this.streamStats = null
    this.queue = null
    this.actionBusy = false
    // 自主连玩：进行中的任务信息（null = 没在玩）；以及「连玩结束后要还的焦点」
    this.playing = null
    this.pendingRestoreHwnd = 0
    this.health = { playable: false, reason: '还没启动' }
    this.configEpoch = 0
    this.disposed = false
  }

  get cfg() { return normalizeConfig(this.getConfig()) }

  /* ---------------- 原生后端 ---------------- */

  async ensureBackend() {
    if (this.backend && !this.backend.dead) {
      await this.backend.start()
      return this.backend
    }
    this.backend = new NativeBackend()
    const info = await this.backend.start()
    if (!info.koffiOk) {
      throw new Error(`原生后端起来了，但 koffi 拿不到 ⇒ 只能看不能操作。koffi 来源：${info.koffi}`)
    }
    this.log(`[icey] 原生后端就绪，koffi 来自 ${info.koffi}`)
    return this.backend
  }

  /* ---------------- 找窗口 / 启动 ---------------- */

  /** 找已经在跑的 ICEY，并接上去 */
  /**
   * 自愈：句柄失效但游戏其实还在跑 ⇒ 悄悄重新接上。
   *
   * 🔴 为什么必须有这个：direct 启动时 Unity 会**再 fork 一次**，
   *    我们一开始拿到的 pid/hwnd 会随第一个进程退出而失效，
   *    游戏却还在（新 pid + 新 hwnd）。没有自愈的话，插件会一直报
   *    「游戏已退出」，而用户看着屏幕上游戏明明开着 —— 这正是最难解释的那种 bug。
   * @returns {Promise<boolean>} 现在是不是接上的状态
   */
  async #ensureAttached() {
    if (this.hwnd && this.backend && !this.backend.dead) {
      const alive = await this.backend.alive(this.hwnd).catch(() => null)
      if (alive?.ok && alive.alive) return true
    }
    // 句柄没了：找一下游戏还在不在
    try {
      const found = await this.ensureBackend().then((b) => b.find('ICEY.exe'))
      if (found?.ok && found.found) {
        const changed = found.hwnd !== this.hwnd || found.pid !== this.pid
        this.hwnd = found.hwnd
        this.pid = found.pid
        this.startedAt = this.startedAt || Date.now()
        if (changed) this.log(`[icey] 窗口变了，已重新接上（hwnd ${found.hwnd}, pid ${found.pid}）`)
        await this.refreshHealth()
        this.ensureQueue()
        return true
      }
    } catch (e) {
      this.lastError = String(e?.message || e)
    }
    this.hwnd = 0
    this.pid = 0
    return false
  }

  async attach() {
    const backend = await this.ensureBackend()
    const found = await backend.find('ICEY.exe')
    if (!found.ok) throw new Error(found.error || '查找窗口失败')
    if (!found.found) {
      this.hwnd = 0
      this.pid = 0
      this.health = { playable: false, reason: '没找到 ICEY 窗口' }
      return { attached: false, reason: '没找到正在运行的 ICEY。先手动打开游戏，或者用 launchMode=steam / direct 让插件启动它。' }
    }
    this.hwnd = found.hwnd
    this.pid = found.pid
    this.startedAt = this.startedAt || Date.now()
    this.lastError = ''
    await this.refreshHealth()
    this.ensureQueue()
    return {
      attached: true, hwnd: this.hwnd, pid: this.pid,
      title: found.title, rect: found.rect, minimized: found.minimized,
      foreground: !!found.foreground, health: this.health,
    }
  }

  /**
   * 启动游戏。
   * attach：只接已经开着的；steam：steam://rungameid；direct：直接跑 exe（带窗口化参数）。
   */
  async launch(mode) {
    const cfg = this.cfg
    const how = mode || cfg.launchMode
    this.launchInfo = { how, at: Date.now(), args: [] }

    if (how === 'attach') {
      return { launched: false, mode: how, ...(await this.attach()) }
    }

    if (how === 'steam') {
      if (!this.spawnProcess) throw new Error('这个部署没有启动进程的能力，没法拉起 Steam')
      // 先拉起 UU 加速器（用户 2026-10-24 要求：启动 Steam 前先开 UU）。
      // UU 是单实例的：已经在跑时再调一次只会激活它的窗口，不会起第二个进程。
      let uu = null
      if (cfg.ensureUu) {
        const uuPath = cfg.uuLauncherPath
        if (uuPath && existsSync(uuPath)) {
          try {
            await this.spawnProcess({ command: uuPath, args: [] })
            uu = { launched: true, path: uuPath }
            if (cfg.uuWaitMs > 0) await new Promise((r) => setTimeout(r, cfg.uuWaitMs))
          } catch (e) {
            uu = { launched: false, path: uuPath, error: e?.message || String(e) }
          }
        } else {
          uu = { launched: false, path: uuPath, error: '找不到 uu_launcher.exe，检查 uuLauncherPath 配置' }
        }
      }
      const url = `steam://rungameid/${cfg.steamAppId}`
      await this.spawnProcess({ command: 'cmd.exe', args: ['/c', 'start', '', url] })
      this.launchInfo.args = [url]
      return {
        launched: true, mode: how, url, uu,
        note: uu?.launched
          ? '先拉起了 UU 加速器，再请求 Steam 启动游戏'
          : '已请求 Steam 启动游戏，等它开窗口',
      }
    }

    // direct：直接跑 exe。窗口化参数更稳妥（全屏也能跑，但抓帧和切窗口麻烦）
    if (!this.spawnProcess) throw new Error('这个部署没有启动进程的能力，没法直接启动游戏')
    const exe = exePathOf(cfg)
    const args = cfg.windowedFix ? [...WINDOWED_ARGS] : []
    await this.spawnProcess({
      command: exe,
      args,
      cwd: cfg.gameDir,
    })
    this.launchInfo.args = args
    return {
      launched: true, mode: how, exe, args,
      note: args.length ? '已用窗口化参数启动' : '已启动（没加窗口化参数）',
    }
  }

  /**
   * 等窗口出现。
   * ⚠️ 不能「窗口一存在就接」：Unity 会先开一个 **320x240 的启动窗**，几秒后才长成
   *    正常分辨率。太早接上，抓帧和按键坐标全是错的。所以要求宽度 >= minWidth。
   * @param {number} timeoutMs
   * @param {{minWidth?: number}} [opts]
   */
  async waitForWindow(timeoutMs = 60_000, opts = {}) {
    const backend = await this.ensureBackend()
    const minWidth = opts.minWidth ?? 640
    const deadline = Date.now() + timeoutMs
    let lastSeen = null
    while (Date.now() < deadline) {
      if (this.disposed) return { ok: false, reason: '插件已停止' }
      const found = await backend.find('ICEY.exe')
      if (found.ok && found.found) {
        lastSeen = found
        const w = found.rect?.width || 0
        if (w >= minWidth) {
          this.hwnd = found.hwnd
          this.pid = found.pid
          await this.refreshHealth()
          this.ensureQueue()
          return {
            ok: true, hwnd: this.hwnd, pid: this.pid, rect: found.rect,
            waitedMs: timeoutMs - (deadline - Date.now()),
          }
        }
      }
      // 500ms 一探：启动窗 → 正常窗口的切换大约几秒，探太慢会白白多等
      await new Promise((r) => setTimeout(r, 500))
    }
    // 超时了但至少见过窗口：接上它（可能分辨率真的只有这么大），但要说清楚
    if (lastSeen) {
      this.hwnd = lastSeen.hwnd
      this.pid = lastSeen.pid
      await this.refreshHealth()
      this.ensureQueue()
      return {
        ok: true, hwnd: this.hwnd, pid: this.pid, rect: lastSeen.rect,
        warning: `窗口一直是 ${lastSeen.rect?.width}x${lastSeen.rect?.height}，没长到 ${minWidth} 宽 —— 可能还在加载，或者游戏分辨率被设得很小。`,
      }
    }
    return {
      ok: false,
      reason: `${timeoutMs / 1000} 秒内没等到 ICEY 窗口。检查游戏是不是启动失败（看 gameDir 下的 output_log.txt）。`,
    }
  }

  /* ---------------- 状态 ---------------- */

  async refreshHealth() {
    if (!this.hwnd) {
      this.health = { playable: false, reason: '没接上游戏窗口' }
      return this.health
    }
    const cfg = this.cfg
    try {
      const a = await assessPlayability(this.backend, this.hwnd, { allowFocus: cfg.allowFocus })
      this.health = { ...a, at: Date.now() }
    } catch (e) {
      this.health = { playable: false, reason: `健康检查失败：${e?.message || e}`, at: Date.now() }
    }
    return this.health
  }

  async status() {
    const cfg = this.cfg
    // 先自愈一次：句柄失效但游戏还在跑的话，这里就悄悄接回来了
    await this.#ensureAttached().catch(() => false)
    const out = {
      running: !!this.hwnd,
      hwnd: this.hwnd || null,
      pid: this.pid || null,
      startedAt: this.startedAt || null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastFrameAt: this.lastFrameAt || null,
      lastHash: this.lastHash || null,
      launchInfo: this.launchInfo,
      health: this.health,
      queue: this.queue ? this.queue.snapshot() : null,
      viewers: this.viewers || 0,
      playing: this.playing
        ? {
          elapsedMs: Date.now() - this.playing.startedAt,
          seconds: this.playing.seconds,
          preset: this.playing.preset,
          actions: { ...this.playing.actions },
          events: this.playing.events.slice(-3),
          guide: this.playing.guide || null,
        }
        : null,
      streamStats: this.streamStats,
      config: {
        launchMode: cfg.launchMode, fps: cfg.fps, captureMode: cfg.captureMode,
        inputBackend: cfg.inputBackend, allowFocus: cfg.allowFocus, maxFrameWidth: cfg.maxFrameWidth,
      },
      backend: this.backend
        ? { koffiOk: this.backend.koffiOk, koffi: this.backend.koffi, dead: this.backend.dead, lastError: this.backend.lastError }
        : null,
      lastError: this.lastError || null,
    }
    if (this.hwnd && this.backend && !this.backend.dead) {
      const alive = await this.backend.alive(this.hwnd).catch(() => null)
      out.windowAlive = alive ? !!alive.alive : null
      out.rect = alive?.rect || null
      out.minimized = alive ? !!alive.minimized : null
      if (alive && !alive.alive) {
        out.running = false
        out.lastError = '游戏窗口已经不在了（游戏退出或崩溃）'
      }
    }
    return out
  }

  /* ---------------- 抓帧 ---------------- */

  /** 给 agent 看的一帧：PNG bytes */
  async look(opts = {}) {
    if (!(await this.#ensureAttached())) throw new Error('还没接上游戏窗口：先 icey_start')
    const cfg = this.cfg
    const frame = await grabFrame(this.backend, this.hwnd, {
      captureMode: cfg.captureMode,
      maxWidth: opts.maxWidth ?? cfg.maxFrameWidth,
      forAgent: true,
    })
    if (!frame.ok) throw new Error(frame.error)
    this.lastFrameAt = Date.now()
    this.lastHash = frame.health.hash
    return { ...frame, png: toPng(frame) }
  }

  /**
   * 抓一帧并**裁出指定区域**（比例坐标），返回 PNG。
   *
   * 用途：ICEY 的互动提示框（「坐标：… / 海拔：… / ⏎: 开启强化」）在右中那一块，
   * 像素阈值检测不可靠（实测阈值 200 以上全 0%），但**原分辨率裁图给模型看是可靠的** ——
   * 模型能直接读字，比任何启发式都准。
   */
  async lookCrop(box, opts = {}) {
    if (!(await this.#ensureAttached())) throw new Error('还没接上游戏窗口：先 icey_start')
    const cfg = this.cfg
    // 🔴 关键：ICEY 的互动提示框**只在游戏窗口处于前台时才渲染**。
    //    实测：act() 之后立刻抓的图有提示（那时窗口还是前台），
    //    而普通的 look() 是焦点已还给 DSH 时抓的 —— 提示框不在画面上，所以永远读不到。
    //    所以要读提示时必须先抢前台，抓完再还回去。
    let restoreTo = 0
    if (opts.focus !== false) {
      const fg = await ensureForeground(this.backend, this.hwnd, {
        allowFocus: true,
        restoreFocus: false,
      }).catch(() => null)
      if (fg?.ok) restoreTo = fg.previousHwnd || 0
    }
    try {
      return await this.#cropAndEncode(box, opts)
    } finally {
      if (restoreTo) {
        await restoreForeground(this.backend, restoreTo).catch(() => {})
      }
    }
  }

  /** @private 抓帧 + 裁剪 + 编码（不含抢前台逻辑） */
  async #cropAndEncode(box, opts = {}) {
    const cfg = this.cfg
    const frame = await grabFrame(this.backend, this.hwnd, {
      captureMode: cfg.captureMode,
      maxWidth: opts.maxWidth ?? cfg.maxFrameWidth,
      forAgent: true,
    })
    if (!frame.ok) throw new Error(frame.error)
    const x = Math.floor(frame.width * box.x0)
    const y = Math.floor(frame.height * box.y0)
    const w = Math.floor(frame.width * (box.x1 - box.x0))
    const h = Math.floor(frame.height * (box.y1 - box.y0))
    const cut = cropRgba(frame.rgba, frame.width, frame.height, x, y, w, h)
    const png = encodePng(cut.width, cut.height, cut.data)
    // 顺带算「白字占比」：实测 无提示 ≈0.02%，有提示 0.23~0.40%（差 10~20 倍），
    // 这是“这里能不能互动”的可靠判据（前提：原分辨率 + 抢到前台）。
    let bright = 0
    let total = 0
    for (let i = 0; i < cut.data.length; i += 4) {
      const lum = cut.data[i] * 0.299 + cut.data[i + 1] * 0.587 + cut.data[i + 2] * 0.114
      if (lum > 200) bright++
      total++
    }
    const promptScore = total ? bright / total : 0
    return { png, width: cut.width, height: cut.height, atMs: Date.now(), promptScore }
  }

  /** 给人看的一帧：RGBA（面板单帧兜底用；实时流走 captureStreamFrame） */
  async lookRaw() {
    if (!(await this.#ensureAttached())) throw new Error('还没接上游戏窗口')
    const cfg = this.cfg
    const frame = await grabFrame(this.backend, this.hwnd, {
      captureMode: cfg.captureMode,
      maxWidth: cfg.streamWidth,
      forAgent: true,
    })
    if (!frame.ok) throw new Error(frame.error)
    this.lastFrameAt = Date.now()
    this.lastHash = frame.health.hash
    return frame
  }

  /* ---------------- 动作 ---------------- */

  ensureQueue() {
    if (this.queue) {
      this.queue.revive()
      return this.queue
    }
    this.queue = new ActionQueue({
      run: (job) => this.#runPlan(job.plan, job.timeoutMs ?? ACTION_TIMEOUT_MS, { holdFocus: !!job.holdFocus }),
      releaseAll: () => this.releaseAll(),
    })
    return this.queue
  }

  /**
   * 真的按键：抢前台 → 逐 step 按下/按住/松开 → **把焦点还给用户**。任何异常都要松键。
   * @param {{holdFocus?: boolean}} [opts] holdFocus=true 时**不还焦点**（自主连玩时用：
   *        连玩期间会连着按十几次键，每次都还焦点会造成来回闪；由调用方在结束时统一还）
   */
  async #runPlan(plan, timeoutMs, opts = {}) {
    const cfg = this.cfg
    if (!this.hwnd) throw new Error('没接上游戏窗口')
    const fg = await ensureForeground(this.backend, this.hwnd, { allowFocus: cfg.allowFocus })
    if (!fg.ok) throw new Error(fg.reason || '抢前台失败')
    // 记下「动作前是谁在前台」，交给调用方在整段结束时还原
    if (opts.holdFocus && fg.previousHwnd) this.pendingRestoreHwnd = fg.previousHwnd

    const watchdog = setTimeout(() => {
      void this.releaseAll().catch(() => {})
      this.log('[icey] 动作看门狗超时，已强制松键')
    }, timeoutMs)

    try {
      for (const step of plan.steps) {
        const down = await this.backend.keydown(step.key)
        if (!down.ok) throw new Error(down.error || `按下 ${step.key} 失败`)
        try {
          // 并发步（withSteps）：主键**按住**期间依次点按子键。
          // 用来打「↓+J（凝滞）」「↑+J（激发）」这类组合键 —— 串行写法游戏收不到。
          if (Array.isArray(step.withSteps) && step.withSteps.length) {
            let used = 0
            for (const sub of step.withSteps) {
              const sd = await this.backend.keydown(sub.key)
              if (!sd.ok) {
                this.log(`[icey] 子键 ${sub.key} 按下失败：${sd.error}（继续）`)
                continue
              }
              try {
                await new Promise((r) => setTimeout(r, sub.holdMs))
              } finally {
                const su = await this.backend.keyup(sub.key)
                if (!su.ok) this.log(`[icey] 子键 ${sub.key} 松开失败：${su.error}`)
              }
              used += sub.holdMs
            }
            const rest = Math.max(0, step.holdMs - used)
            if (rest > 0) await new Promise((r) => setTimeout(r, rest))
          } else {
            await new Promise((r) => setTimeout(r, step.holdMs))
          }
        } finally {
          const up = await this.backend.keyup(step.key)
          if (!up.ok) this.log(`[icey] 松开 ${step.key} 失败：${up.error}`)
        }
      }
    } finally {
      clearTimeout(watchdog)
      // 动作收尾再兜一次，防漏
      await this.backend.releaseAll().catch(() => {})
      // 用完把焦点还给用户（DSH 就在前面了）—— 这是「开了艾希 DSH 就不能用」的根因修复
      // holdFocus 时不还：自主连玩会连按十几次，逐次还焦点只会让窗口来回闪，
      // 交给 play() 在整段结束时统一还原（见 pendingRestoreHwnd）。
      if (!opts.holdFocus && cfg.restoreFocus && fg.previousHwnd) {
        const back = await restoreForeground(this.backend, fg.previousHwnd).catch(() => null)
        if (!back?.restored) this.log('[icey] 焦点没还回去（不影响按键，但用户可能要自己点一下 DSH）')
      }
    }
  }

  /**
   * 执行一个语义动作。立即返回受理结果；diff 用 true 时等执行完再抓前后帧。
   */
  async act(input, opts = {}) {
    if (!(await this.#ensureAttached())) {
      return { ok: false, error: '还没接上游戏窗口：先 icey_start' }
    }
    const cfg = this.cfg
    let plan
    try {
      plan = planAction(input, { keyMap: cfg.keyMap })
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
    this.ensureQueue()
    if (!opts.withDiff) {
      const res = await this.queue.push({ plan, input })
      return { ...res, plan: plan.steps.map((s) => s.label), desc: plan.desc }
    }
    // 要前后对比：串行做，别和别的动作混
    // 用**缩略帧**算差异就够了（而且更稳：原始分辨率里一粒灰尘的变化也会算进去）
    const diffWidth = Math.min(cfg.streamWidth, 640)
    const shot = () => this.captureStreamFrame(diffWidth).catch((e) => ({ ok: false, error: String(e?.message || e) }))
    const before = await shot()
    const res = await this.queue.push({ plan, input })
    if (!res.accepted) return { ok: false, error: res.reason }
    // 等队列把这条跑完
    const waited = await this.#waitIdle(4000)
    const after = await shot()
    if (!before.ok || !after.ok) {
      return { ok: true, accepted: true, desc: plan.desc, steps: plan.steps.map((s) => s.label), changed: null, note: '前后帧没抓成，无法给出画面差异' }
    }
    const diff = diffRatio(before.rgba, after.rgba)
    return {
      ok: true, accepted: true, desc: plan.desc,
      steps: plan.steps.map((s) => s.label),
      changed: diff > 0.005,
      diff: +diff.toFixed(4),
      beforeHash: before.health.hash, afterHash: after.health.hash,
      idleWaited: waited,
      note: diff > 0.005
        ? '画面变了。ICEY 待机也有动画，所以这不是「按键生效」的铁证；要确认角色响应，看画面里角色位置/朝向，或再连做两次同一动作对比。'
        : '画面几乎没变：动作可能没生效。检查游戏是否在前台、角色是否在过场动画或菜单里。',
    }
  }

  /** 等队列空 */
  async #waitIdle(maxMs = 4000) {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      if (!this.queue || (!this.queue.busy && this.queue.depth === 0)) return Date.now() - t0
      await new Promise((r) => setTimeout(r, 40))
    }
    return -1
  }

  /* ---------------- 自主连玩 ---------------- */

  /**
   * 自己玩一段。这是「不用每步都问」的核心：
   * **一次调用跑完一整段**，途中按策略决定走位/攻击/过对话，返回摘要 + 几张关键帧。
   *
   * 限制说清楚（也写进工具描述）：这是**侧滚轴游戏的常识性自动驾驶**，
   * 不是视觉大模型 —— 它靠「画面动不动」「HUD 变不变」两个信号，能自己推进和打架，
   * 但真正的解谜/分支选择会卡住，所以有「连续卡住就停」和按时截图汇报。
   *
   * @param {object} opts
   * @param {number} [opts.seconds=30] 玩多久（5–300 秒）
   * @param {'advance'|'fight'|'explore'} [opts.preset='advance']
   * @param {number} [opts.captureEvery=12] 每隔几秒留一张途中截图
   * @param {number} [opts.maxFrames=3] 最多留几张（0 = 不留）
   * @param {string} [opts.dir='right'] 推进方向
   * @param {(progress:object)=>void} [opts.onTick] 进度回调（面板/路由用来显示「正在连玩」）
   * @returns {Promise<{ok:boolean, seconds?:number, preset?:string, actions?:object, events?:string[], frames?:Array, stopped?:string, error?:string}>}
   */
  async play(opts = {}) {
    const cfg = this.cfg
    if (!(await this.#ensureAttached())) {
      return { ok: false, error: '还没接上游戏窗口：先 icey_start' }
    }
    await this.refreshHealth()
    if (!this.health?.playable) {
      return { ok: false, error: `现在不能操作：${this.health?.reason || '原因未知'}` }
    }
    if (this.playing) return { ok: false, error: '已经在连玩了（同一个游戏只能有一个连玩任务）' }

    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
    }
    const seconds = clamp(opts.seconds, 5, 300, 30)
    const preset = PRESETS[opts.preset] ? opts.preset : 'advance'
    const captureEvery = clamp(opts.captureEvery, 3, 120, 12)
    const maxFrames = clamp(opts.maxFrames, 0, 4, 3)
    const policy = createPolicy(preset, { moveDir: opts.dir || 'right' })
    /** 结束时是否因为还在战斗而按了 Esc 暂停（真机踩到两次角色被打死） */
    let safetyPaused = false

    this.playing = { startedAt: Date.now(), seconds, preset, actions: {}, events: [], frames: 0, eventLog: new EventLog() }
    const run = this.playing
    // 上一轮的摘要要在**本轮开始前**读，否则写完自己就被当成"上一轮"了
    const prevRun = previousRun()
    // 参考 GameScaling `history_len`：保留最近若干次决策的（动作 + 理由），
    // 让「跨调用」也有上下文（icey_play 是单轮工具，模型看不到上一轮干了什么）。
    const historyLen = clamp(opts.historyLen, 0, 20, 8)
    const history = []
    // 分析用的低分辨率帧：抓得快（~40ms），够算 motion。
    // 宽度固定（来自配置）能让像素阈值/模板稳定 —— 对齐 GameScaling「统一缩放输入帧」的做法。
    const analysisWidth = cfg.analysisWidth || 480
    const t0 = Date.now()

    /**
     * 记一条事件：同时写两份。
     *   run.events   —— 字符串，保持旧输出的文案格式（agent.js 和面板都在读它）
     *   run.eventLog —— 结构化（带 kind/level/时间戳），给摘要、统计、跨回合存盘用
     * 为什么要两份：旧格式不能动（一改面板和输出全变），而字符串没法按类型过滤。
     *
     * @param {number|null} severity 严重度（同类事件合并时比较用，越大越严重）。不传按等级算。
     */
    const note = (kind, level, text, data = {}, severity = null) => {
      const atSec = +((Date.now() - t0) / 1000).toFixed(1)
      run.events.push(text)
      run.eventLog.push(kind, level, text, data, atSec, severity)
    }

    let prev = null
    // 掉血事件的基线。注意 hudBright 是「左上 HUD 亮像素占比」，不是真的血量百分比——
    // 它同时受血条长度和连击数字影响，所以文案写「血条亮度跌 X%」而不是「掉血 X%」，
    // 措辞必须如实，不然模型会把它当成精确血量去算。
    let hpBase = 0
    let lastDamageAt = 0
    // 处决按下后挂一个观察窗口：处决的回血/回盾/掉结晶都发生在接下来一两秒
    let execAt = 0
    let execHpBefore = 0
    // 净进展参照：约 2.5 秒前的帧。相邻帧差异会被待机动画骗过去，
    // 「2.5 秒里画面几乎没变」才是真的原地踏步（比如被门/墙挡住）。
    let progressRef = null
    let lastProgress = null
    // 判定「走不通」时抓的那张现场图：要优先给模型看，而不是按时间采到的那张
    let blockedShot = null
    // 交互提示区的裁图（给模型读字用）
    let promptShot = null
    let lastArrowProbe = 0
    let execShot = null
    let lastArrow = null
    // 宝箱追踪：靠持续性确认，避免把技能特效当成宝箱（连钱符号都是蓝的，颜色判据不够用）
    const chestTracker = createChestTracker()
    // 提示框信号：定期裁一次提示区算「白字占比」，喂给策略判断"这里能不能互动"
    let promptScore = null
    let lastPromptProbe = 0
    let lastShotAt = -Infinity
    let stopped = ''
    const frames = []
    const deadline = t0 + seconds * 1000
    // 游戏无响应检测（见 lib/ui/frame-print.mjs）：画面完全静止 + 期间按过键 ⇒ 不是卡住，是死了
    const freeze = createFreezeDetector()
    let actedSinceLastFeed = false

    this.log(`[icey] 开始自主连玩：${preset}，${seconds}s`)

    try {
      while (Date.now() < deadline) {
        if (this.disposed) { stopped = '插件被停止'; break }

        // ① 看一眼（低分辨率）
        let metrics
        try {
          const frame = await this.captureStreamFrame(analysisWidth)
          metrics = analyzeFrame(frame.rgba, frame.width, frame.height, prev)
          prev = { rgba: frame.rgba, width: frame.width, height: frame.height, hud: metrics.hud }

          // 游戏还活着吗？
          // 画面连续多帧**一个像素都不变**、而我们这期间又按过键 ⇒ 不是「卡住」，是游戏死了。
          // 2026-10-24 真机吃过这个亏：Enter/Esc/Q 全被吞，画面五次操作 SHA 完全一致，
          // 插件却一路记「已完成 N」，以为一切正常。早停比乱按强。
          freeze.feed(frame.rgba, frame.width, frame.height, { acted: actedSinceLastFeed })
          actedSinceLastFeed = false
          if (freeze.frozen) {
            stopped = `画面连续 ${freeze.streak} 帧完全不变（这期间按了 ${freeze.actedSinceChange} 次键）—— 游戏大概率已无响应，不是卡住。停手把画面交回`
            break
          }
          // 净进展：跟 ~2.5 秒前的画面比
          if (progressRef && frame.width === progressRef.width && frame.height === progressRef.height) {
            lastProgress = diffRatio(frame.rgba, progressRef.rgba)
          }
          if (!progressRef || Date.now() - progressRef.at >= 2500) {
            progressRef = { rgba: frame.rgba, width: frame.width, height: frame.height, at: Date.now() }
          }
          metrics.progress = lastProgress

          // 环境感知：可破坏物 / 隐藏房间接缝（每帧算，32×18 网格，开销很小）
          const env = analyzeEnvironment(frame.rgba, frame.width, frame.height)
          // 画面里的方向箭头（游戏给的指引）：跟着它走。
          // ⚠️ 必须在**高分辨率**下检测：缩到 400 宽时箭头细描边会糊掉（实测 640 宽就识别不了）。
          //    所以每 2 秒单独抓一张原生分辨率帧来查箭头，平时沿用上次结果。
          if (Date.now() - lastArrowProbe > 2000) {
            lastArrowProbe = Date.now()
            try {
              const hi = await grabFrame(this.backend, this.hwnd, {
                captureMode: cfg.captureMode,
                maxWidth: 0,        // 原生分辨率
                forAgent: true,
              })
              if (hi.ok) {
                const arrow = findGuideArrow(hi.rgba, hi.width, hi.height)
                lastArrow = arrow.hit ? arrow : null
              }
            } catch { /* 抓不到就沿用上次 */ }
          }
          // 菜单结构指标（识别「停在强化/暂停界面」）
          metrics.darkRatio = env.darkRatio
          metrics.listBands = env.listBands
          metrics.longLines = env.longLines

          // 处决提示：**黑底白 L 键帽**（2026-10-24 用用户录屏的真实样本校准，
          // 之前一直按「金色环」找，方向是错的 —— 详见 lib/execute-keycap.mjs 顶部注释）。
          // ⚠️ 已知局限：游戏里所有按键提示都是同款键帽（追猎是 U、连击是 E），
          //    这里的形状判据分不出字母，所以它命中的可能是 U/E 键帽而不只是 L。
          //    代价是多按一次 L（无目标时无效），可以接受；要精确区分得做字形识别。
          const exec = findExecuteKeycap(frame.rgba, frame.width, frame.height)
          metrics.executePrompt = exec.hit
          metrics.executeX = exec.x
          if (exec.hit && !execShot) {
            execShot = { png: null, width: frame.width, height: frame.height, atMs: Date.now() - t0, reason: 'execute' }
            try {
              const cut = await this.lookCrop({ x0: Math.max(0, (exec.x ?? 0.5) - 0.2), y0: 0.30, x1: Math.min(1, (exec.x ?? 0.5) + 0.2), y1: 0.95 })
              execShot.png = cut.png
              execShot.width = cut.width
              execShot.height = cut.height
              // 文案别再写「黄圈」——键帽检测早就校准成黑底白 L 了（见 lib/execute-keycap.mjs 顶部）
              note('execute-seen', 'urgent', `第 ${((Date.now() - t0) / 1000).toFixed(0)}s 发现处决提示（白 L 键帽）→ 按 L`, { x: exec.x ?? null })
            } catch { /* 抓不到就算了 */ }
          }
          // 检测到宝箱时容易把宝箱边框误判成箭头，所以有宝箱就不看箭头
          metrics.arrowDir = lastArrow && env.chest === 0 ? lastArrow.dir : null
          metrics.arrowX = lastArrow ? lastArrow.x : null
          metrics.destructible = env.destructible
          metrics.destructibleX = env.destructibleX
          metrics.seam = env.seam
          metrics.seamX = env.seamX
          // 隐藏房间指纹（满屏青色网格）。策略用它切「扫荡模式」，见 lib/autoplay.mjs 的 gridRoom 注释。
          metrics.gridRoom = !!env.gridRoom
          metrics.cyanRatio = env.cyanRatio ?? null
          // 战斗屏障：横跨场景两端的能量墙，只在敌人清光后消失。
          // 拿去喂 policy 的 fighting 判定 —— 敌人倒地不动时它是唯一还亮着的证据。
          metrics.barrier = !!env.barrier
          metrics.barrierEdge = env.barrierEdge ?? null

          // 宝箱要「持续存在」才认，避免特效误判。
          // 额外上下文过滤：**打架时**的青色亮块多半是剑光/爆发，不当作透明宝箱。
          // ⚠️ 但隐藏房间里这条会误杀：那儿的宝箱本身就是青色的，房间里又在打架。
          //    实测（2026-10-24）图 B 的透明宝箱能命中 (28%,31%)，打架时却被这条过滤掉。
          //    所以房间内不启用这个过滤 —— 房间是已知场景，误报代价低于漏掉整箱金币。
          const ghostSuspicious = env.chestKind === 'ghost' && policy.fighting && !env.gridRoom
          const confirmed = ghostSuspicious ? null : chestTracker.feed(env, Date.now() - t0)
          if (confirmed) {
            metrics.chestConfirmed = true
            metrics.chestX = confirmed.x
            metrics.chestAgeMs = confirmed.sinceMs
            if (run.events.length < 3 || !run.events.some((e) => /宝箱/.test(e))) {
              note('chest', 'notable', `第 ${((Date.now() - t0) / 1000).toFixed(0)}s 确认到宝箱（持续 ${(confirmed.sinceMs / 1000).toFixed(1)}s，x=${(confirmed.x * 100).toFixed(0)}%）`, { x: +confirmed.x.toFixed(3), heldMs: confirmed.sinceMs })
            }
          } else {
            metrics.chestConfirmed = false
          }

          // 用最近一次探测到的提示框信号（analyzeFrame 里那个旧算法在 400 宽下不可靠）
          metrics.promptBright = promptScore

          // 卡住时定期探测「有没有互动提示框」（原分辨率裁图 + 亮字占比）
          // 心跳式探测：不只在卡住时探。站在机关旁正常走动时也该看一眼有没有提示，
          // 否则「按提示框操作」永远等不到时机。代价约 80ms / 4 秒，可忽略。
          const shouldProbe = (policy.stillStreak > 0 && Date.now() - lastPromptProbe > 1200)
            || (Date.now() - lastPromptProbe > 4000)
          if (shouldProbe) {
            lastPromptProbe = Date.now()
            try {
              // 提示框要角色**站定**才渲染，所以先歇一下再裁（不然拍到的是走路中的画面）
              await new Promise((r) => setTimeout(r, 350))
              const cut = await this.lookCrop({ x0: 0.30, y0: 0.35, x1: 0.99, y1: 0.90 })
              promptScore = cut.promptScore
              metrics.promptBright = cut.promptScore
              // 裁图**始终**留给模型看（模型能读字），只是额外标注有没有检测到文字
              if (!promptShot) {
                promptShot = {
                  // 这里不能用 elapsed —— 它的 const 声明在下面，会 TDZ 报错被外层 catch 吞掉
                  png: cut.png, width: cut.width, height: cut.height, atMs: Date.now() - t0,
                  reason: 'prompt', hasText: cut.promptScore >= 0.0008,
                }
              }
            } catch { /* 抓不到就算了 */ }
          }
        } catch (e) {
          stopped = `抓帧失败：${e?.message || e}`
          break
        }
        if (!metrics?.ok) { stopped = metrics?.reason || '帧不可用'; break }

        // ② 决定这一步做什么
        const elapsed = Date.now() - t0
        const decision = policy.decide(metrics, { now: elapsed })

        // 面板上的「箭头指引」数据：这一步打算往哪走、为什么、目标是什么
        run.guide = {
          action: decision.action,
          dir: decision.dir || null,
          why: decision.why || '',
          target: metrics.chestConfirmed
            ? { kind: 'chest', x: metrics.chestX }
            : (metrics.seam ? { kind: 'hidden', x: metrics.seamX } : null),
          at: Date.now(),
        }

        // ②b 策略说「等一等」（比如还没进游戏、界面正在加载）：不按任何键，只歇一下
        if (decision.action === 'wait') {
          opts.onTick?.({
            elapsedMs: elapsed, preset, action: 'wait', why: decision.why,
            motion: metrics.motion, fighting: false,
            actions: { ...run.actions }, frames: frames.length,
          })
          await new Promise((r) => setTimeout(r, Math.max(120, decision.ms || 250)))
          continue
        }

        // ③ 执行（走队列，跟手动操作同一条路：抢前台 + SendKeys + 看门狗松键）
        let plan
        try {
          plan = planAction(decision, { keyMap: cfg.keyMap })
        } catch (e) {
          stopped = `动作非法（${decision.action}）：${e?.message || e}`
          break
        }
        const res = await this.ensureQueue().push({
          plan, input: decision,
          holdFocus: true,                       // 连玩期间不逐次还焦点，结束时统一还
          timeoutMs: ACTION_TIMEOUT_MS,
        })
        if (!res.accepted) {
          // 队列满/冷却中：等一小会儿再来，不算失败
          await new Promise((r) => setTimeout(r, 120))
          continue
        }
        await this.#waitIdle(6000)

        // 复合动作（目前只有「跳 + 向上冲刺」这一种，见 autoplay 的 jump-up 阶梯）：
        // 紧跟着排第二个动作，**不等这一跳落地**。中间那点间隔就是队列自己的冷却，
        // 正好落在「已经离地、还没落地」的窗口里 —— 往上冲才能把高度拉开。
        // 失败了也不中断连玩：最坏情况就是只跳了一下（跟旧行为等价）。
        if (decision.followUp) {
          try {
            const fuPlan = planAction(decision.followUp, { keyMap: cfg.keyMap })
            const r2 = await this.ensureQueue().push({
              plan: fuPlan, input: decision.followUp, holdFocus: true, timeoutMs: ACTION_TIMEOUT_MS,
            })
            if (r2.accepted) {
              await this.#waitIdle(6000)
              const fuName = `${decision.followUp.action}:${decision.followUp.dir || ''}`
              run.actions[fuName] = (run.actions[fuName] || 0) + 1
            }
          } catch (e) {
            this.log(`[icey] 复合动作的后半段没执行：${e?.message || e}`)
          }
        }
        actedSinceLastFeed = true
        run.actions[decision.action] = (run.actions[decision.action] || 0) + 1
        // 记一条精简历史（动作 + 理由），最多留 20 条，返回时截取 historyLen 条
        history.push({
          t: +(elapsed / 1000).toFixed(1),
          action: decision.action,
          ...(decision.dir ? { dir: decision.dir } : {}),
          ...(decision.keys ? { keys: decision.keys } : {}),
          why: String(decision.why || '').slice(0, 60),
        })
        if (history.length > 20) history.shift()

        // ④ 记事件
        //    ⚠️ 这里有两个「秒数」：elapsed 是循环自己的计时，note() 内部用的是 Date.now()-t0。
        //    两者在正常帧率下几乎一样，但文案里沿用 elapsed（跟旧输出对得上），
        //    结构化字段用的是 note() 算的时刻 —— 别因此以为对不齐，差在毫秒级。
        if (metrics.motion !== null && metrics.motion > 0.5) {
          note('scene', 'info', `第 ${(elapsed / 1000).toFixed(0)}s 画面剧变（可能切换场景/过场）`, { motion: +metrics.motion.toFixed(2) })
        }
        // 进入/离开隐藏房间（满屏青色网格）。
        // 这个房间里的宝箱时灵时不灵（见 autoplay.mjs 的 gridRoom 注释），
        // 记一条让模型知道「我现在在一个特殊场景里」，而不是以为画面抽风了。
        if (metrics.gridRoom && !run._gridRoomNoted) {
          run._gridRoomNoted = true
          note('grid-room', 'notable', `第 ${(elapsed / 1000).toFixed(0)}s 进入隐藏房间（满屏青色网格）→ 里面常有可破坏的金币宝箱`, { cyanRatio: metrics.cyanRatio })
        } else if (!metrics.gridRoom && run._gridRoomNoted) {
          run._gridRoomNoted = false
          note('grid-room-exit', 'info', `第 ${(elapsed / 1000).toFixed(0)}s 离开隐藏房间`)
        }
        if (policy.fighting && !run._fightNoted) {
          run._fightNoted = true
          note('fight-start', 'notable', `第 ${(elapsed / 1000).toFixed(0)}s 进入战斗（HUD 在跳）`)
        }
        if (!policy.fighting && run._fightNoted) {
          run._fightNoted = false
          note('fight-end', 'info', `第 ${(elapsed / 1000).toFixed(0)}s 战斗结束`, {})
        }
        // —— 新增事件源（2026-10-24：让模型不必看每帧也能知道「刚才发生了什么」）——

        // ① 挨打/掉盾：hudBright 相对基线跌。
        //    信号同源（lib/autoplay.mjs 的 hpBaseline 用同一个量），但这里只负责**记**，
        //    闪避决策仍然在 policy 里做 —— 记录和决策分开，改一个不会碰坏另一个。
        //
        //    ⚠️ 阈值是实测调出来的（2026-10-24 第一次 brief 连玩）：
        //    一开始用 6%，25 秒报了 5 次「掉血 6~16%」，把真正的 urgent 淹掉了。
        //    原因：hudBright 是 HUD 亮像素占比，血条长度和**连击数字**都在改它，
        //    战斗中它本来就在抖。所以 10% 以下不记（那是 HUD 在动，不是挨打）。
        const hpNow = metrics.hudBright ?? 0
        if (hpNow > hpBase) hpBase = hpNow
        if (hpBase > 0) {
          const drop = (hpBase - hpNow) / hpBase
          if (drop >= 0.10 && Date.now() - lastDamageAt > 1500) {
            lastDamageAt = Date.now()
            const pct = Math.round(drop * 100)
            note('damage', drop >= 0.18 ? 'urgent' : 'notable',
              `第 ${(elapsed / 1000).toFixed(0)}s 血条亮度跌 ${pct}%（可能挨打/破盾）`,
              { drop: +drop.toFixed(2), hp: +hpNow.toFixed(3), base: +hpBase.toFixed(3) },
              drop) // severity 用跌幅：合并时保留最严重的那一次（不然 12% 顶着 urgent 的名头）
            hpBase = hpNow // 重新基线，否则同一段掉血会每帧报一次
          }
        }

        // ② 处决的结果：按下后约 1.5 秒结算。处决能回血回盾、掉能量结晶，值得单独记一条。
        if (execAt && Date.now() - execAt > 1500) {
          const gain = hpNow - execHpBefore
          note('execute-result', gain > 0.02 ? 'notable' : 'info',
            `第 ${((execAt - t0) / 1000).toFixed(0)}s 处决后血条${gain > 0.02 ? `回升 ${Math.round(gain * 100)}%` : '没明显变化'}`,
            { gain: +gain.toFixed(3) })
          execAt = 0
        }
        if (decision.action === 'execute') {
          execAt = Date.now()
          execHpBefore = hpNow
        }

        // ③ 出招：记下打了哪套连段。去重窗口 1 秒，所以连打同一套不会刷屏。
        if (decision.action === 'combo' && decision.keys) {
          note('combo', 'info', `第 ${(elapsed / 1000).toFixed(0)}s 出招 ${String(decision.keys).toUpperCase()}`, { keys: decision.keys })
        }

        if (decision.action === 'interact') {
          const isPrompt = /提示框/.test(decision.why || '')
          note(isPrompt ? 'interact-prompt' : 'interact-blind', 'info',
            isPrompt
              ? `第 ${(elapsed / 1000).toFixed(0)}s 看到互动提示框 → 按了 Enter`
              : `第 ${(elapsed / 1000).toFixed(0)}s 卡住了，按了确认键`)
        }
        if (/掉头/.test(decision.why || '')) {
          note('blocked', 'urgent', `第 ${(elapsed / 1000).toFixed(0)}s 这处过不去（有提示框才能互动，没有提示的多半是剧情锁）→ 掉头探索另一边`)
          // 把「过不去」那一刻的画面抓下来：模型最需要看的是这张，而不是随便一张途中图
          if (!blockedShot) {
            try {
              const shot = await this.look({ maxWidth: 640 })
              blockedShot = { png: shot.png, width: shot.width, height: shot.height, atMs: elapsed, reason: 'blocked' }
            } catch { /* 抓不到就算了 */ }
          }
          // 再把「交互提示区」按**原分辨率**裁一张：ICEY 的提示框（「⏎: 开启强化」那种）
          // 就浮在角色右中那块。像素阈值检测不可靠，但裁图给模型读字是可靠的。
          if (!promptShot) {
            try {
              const cut = await this.lookCrop({ x0: 0.42, y0: 0.38, x1: 0.99, y1: 0.86 })
              promptShot = { png: cut.png, width: cut.width, height: cut.height, atMs: elapsed, reason: 'prompt' }
            } catch { /* 抓不到就算了 */ }
          }
        }

        // ⑤ 途中截图（给模型看进展，别太费 token）
        if (maxFrames > 0 && frames.length < maxFrames && elapsed - lastShotAt >= captureEvery * 1000) {
          lastShotAt = elapsed
          try {
            const shot = await this.look({ maxWidth: 640 })
            frames.push({ png: shot.png, width: shot.width, height: shot.height, atMs: elapsed })
            run.frames = frames.length
          } catch { /* 截图失败不影响连玩 */ }
        }

        opts.onTick?.({
          elapsedMs: elapsed, preset, action: decision.action, why: decision.why,
          motion: metrics.motion, fighting: policy.fighting,
          actions: { ...run.actions }, frames: frames.length,
        })

        // ⑤b 停在菜单里且按了几次 Esc 都没退出 ⇒ 停下交回（别在里面乱按花钱）
        if (policy.menuEscCount >= 3) {
          stopped = '画面一直停在菜单/强化界面：已按 3 次 Esc 仍未退出。为避免误按「升级」花钱，先停在这里，请人工确认界面状态。'
          break
        }

        // ⑥ 连续卡住就交回（解谜/分支选择它处理不了，别死循环）
        // 同时要求「已经玩了一会儿」再判定放弃：假后端里一轮只要 200ms，纯按次数会 3 秒就收手
        if (policy.stillStreak >= 9 && Date.now() - t0 > 8000) {
          stopped = '连着几轮都没进展：这里可能是一扇打不开的门、解谜或分支选择 —— 停下把画面交回，由模型/人来判断'
          break
        }
      }
      if (!stopped) stopped = `玩满 ${seconds} 秒`
    } finally {
      // **收尾保命**（2026-10-24 真机踩到两次）：
      // 连玩结束后游戏并不会停 —— 怪继续打，角色站着不动，两次都被打死在同一个地方
      //（「你又死了」）。所以结束时如果还在战斗，**先按 Esc 把游戏暂停**再松键。
      // Esc 只开关暂停菜单，不碰存档；用户接手时再按一次 Esc 就继续。
      if (policy.fighting) {
        try {
          await this.backend.keydown('Escape')
          await new Promise((r) => setTimeout(r, 100))
          await this.backend.keyup('Escape')
          safetyPaused = true
        } catch { /* 按不动就算了，不能因为收尾失败吞掉正常结果 */ }
      }
      // 无论如何都要：松键 + 还焦点 + 清状态
      await this.releaseAll().catch(() => {})
      if (cfg.restoreFocus && this.pendingRestoreHwnd) {
        await restoreForeground(this.backend, this.pendingRestoreHwnd).catch(() => null)
      }
      this.pendingRestoreHwnd = 0
      this.playing = null
      this.log(`[icey] 自主连玩结束：${stopped}`)
    }

    const realSeconds = (Date.now() - t0) / 1000
    // 存这一轮的摘要（跨调用记忆）：下一轮 icey_play 就能看到「上一轮发生了什么」。
    // 只存摘要不存帧 —— 存帧文件会膨胀，而且模型也用不上原始像素。
    const eventDigest = run.eventLog.digest({ minLevel: 'notable' })
    const eventByKind = run.eventLog.items.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc }, {})
    saveRun({
      at: new Date().toISOString(),
      seconds: +realSeconds.toFixed(1),
      preset,
      stopped,
      eventDigest,
      eventByKind,
      actions: run.actions,
    })
    // 现场图优先：模型拿到的第一张就是「过不去」那一幕
    // 顺序：现场整屏 → 提示区裁图 → 按时间采的途中图
    const framesOut = [blockedShot, execShot, promptShot, ...frames].filter((f) => f && f.png)
    return {
      ok: true,
      seconds: realSeconds,
      preset,
      actions: run.actions,
      events: run.events,
      // 结构化事件的摘要：urgent 在前、notable 次之，info 只数不列。
      // 这是「模型不必看每帧也知道刚才发生了什么」的那一份。
      eventDigest,
      eventCount: run.eventLog.length,
      eventByKind,
      // 上一轮的摘要（跨调用记忆）：这是本轮**开始前**读到的，不是本轮的结果
      previous: prevRun,
      frames: framesOut,
      blocked: !!blockedShot,
      promptSeen: !!promptShot,
      promptText: !!(promptShot && promptShot.hasText),
      // 结束时因为还在战斗而按 Esc 暂停了游戏（防止无人看管时被打死）
      safetyPaused,
      // 最近动作历史（参考 GameScaling 的 history_len）：让模型跨调用也能看到上一轮干了什么
      history: historyLen > 0 ? history.slice(-historyLen) : [],
      stopped,
    }
  }

  /** 直接发一串按键（调试/面板用，绕过语义层） */
  async keys(sequence) {
    if (!this.hwnd) return { ok: false, error: '没接上游戏窗口' }
    const cfg = this.cfg
    const fg = await ensureForeground(this.backend, this.hwnd, { allowFocus: cfg.allowFocus })
    if (!fg.ok) return { ok: false, error: fg.reason }
    const done = []
    try {
      for (const k of sequence) {
        const r = k.up ? await this.backend.keyup(k.key) : await this.backend.keydown(k.key)
        done.push({ key: k.key, up: !!k.up, ok: !!r.ok, error: r.error })
        if (k.ms) await new Promise((r2) => setTimeout(r2, k.ms))
      }
    } finally {
      await this.releaseAll()
    }
    return { ok: true, done }
  }

  async releaseAll() {
    if (!this.backend || this.backend.dead) return []
    try {
      const r = await this.backend.releaseAll()
      return r.released || []
    } catch { return [] }
  }

  /* ---------------- 面板实时画面（拉模式） ---------------- */

  /**
   * 抓一帧给面板看。**由观看方按需调用**（拉模式）——
   * 没人拉就不抓，所以面板一关 CPU 立刻归零。
   *
   * 🔴 一定是**缩过的**帧（streamWidth，默认 960）。理由：
   *    1606x935 原始 RGBA 是 6MB，10fps 就是 60MB/s，光在宿主主线程上
   *    base64/编码就能把 DSH 的 UI 拖死（实测 147ms/秒）。缩到 960 宽后只有
   *    2.1MB，再走二进制帧（不 base64）主线程几乎零成本。
   */
  async captureStreamFrame(width) {
    if (!this.hwnd) throw new Error('还没接上游戏窗口')
    if (!this.backend || this.backend.dead) throw new Error('原生后端不可用')
    const cfg = this.cfg
    const w = Number(width) || cfg.streamWidth
    const t0 = Date.now()
    const frame = await grabFrame(this.backend, this.hwnd, {
      captureMode: cfg.captureMode,
      maxWidth: w,
      forAgent: true,
    })
    this.lastFrameAt = Date.now()
    if (!frame.ok) {
      this.lastError = frame.error
      throw new Error(frame.error)
    }
    this.lastHash = frame.health.hash
    this.lastError = ''
    this.streamStats = { captureMs: Date.now() - t0, width: frame.width, height: frame.height }
    return frame
  }

  /** 有人打开面板了 / 关掉了 —— 只用于状态显示 */
  addViewer() { this.viewers = (this.viewers || 0) + 1; return this.viewers }
  removeViewer() { this.viewers = Math.max(0, (this.viewers || 0) - 1); return this.viewers }

  /* ---------------- 收尾 ---------------- */

  /** 停止：停流 → 松键 → 关 worker。绝不留卡键 */
  async stop(reason = 'stop') {
    this.log(`[icey] 停止（${reason}）`)
    this.viewers = 0
    // 正在自主连玩：停掉时状态要清干净，否则下次 play() 会误判「已经在连玩」
    this.playing = null
    this.pendingRestoreHwnd = 0
    if (this.queue) await this.queue.dispose().catch(() => {})
    this.queue = null
    if (this.backend) {
      await this.backend.releaseAll().catch(() => {})
      await this.backend.dispose().catch(() => {})
    }
    this.backend = null
    this.hwnd = 0
    this.pid = 0
    this.health = { playable: false, reason: `已停止（${reason}）` }
  }

  async dispose(reason = 'dispose') {
    this.disposed = true
    await this.stop(reason)
  }
}

export { frameHash, PING_MS }

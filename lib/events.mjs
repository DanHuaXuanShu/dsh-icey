/**
 * lib/events.mjs —— 结构化事件流（给「我」看，也给策略看）
 * ============================================================================
 * 为什么要有这一层：
 *   连玩时插件每秒转十几圈，而我一次决策要几秒。真正的问题不是让我变快，
 *   是**让我几秒钟的思考变成插件接下来几十秒的行为**。
 *
 *   要做到这一点，插件得把「发生了什么」说清楚：不是一段散字符串，而是
 *   带类型、带等级、能去重、能跨回合保存的事件。
 *
 * 和原来 run.events 的区别：
 *   原来：'第 12s 进入战斗（HUD 在跳）'  ← 纯字符串，没法过滤/统计/复用
 *   现在：{ at: 12, kind: 'fight-start', level: 'notable', text: '...', data: {...} }
 *
 * 三档等级（决定了「我该不该现在管」）：
 *   info    —— 常规流水（进入/离开战斗、场景切换）。跑完可以只记个数字。
 *   notable —— 值得知道（掉血、连招结果、宝箱）。摘要里要出现。
 *   urgent  —— 我该立刻管（卡死原地、盾要破了）。摘要置顶。
 *
 * 去重是必须的：掉血在战斗里会连着掉好几帧，不去重会把摘要刷成一条线。
 * 策略是**同类在窗口内合并成一条**（保留最新数值、记一个 repeat 次数），
 * 而不是简单丢弃 —— 丢弃会低估掉血幅度，合并能保留「掉了 3 次」这个信息。
 * ============================================================================
 */

/** 等级，从低到高 */
export const LEVELS = ['info', 'notable', 'urgent']

/** 每个 kind 的去重窗口（秒）：窗口内同类事件合并成一条 */
const DEDUPE_WINDOW = {
  'fight-start': 3,
  'fight-end': 3,
  damage: 2,
  'execute-seen': 5,
  'execute-result': 3,
  chest: 8,
  blocked: 8,
  scene: 2,
  combo: 1,
  stuck: 5,
  // 互动键按下去有两种原因：看到提示框（该按）和盲按（卡住了乱试）。
  // 分开记很重要 —— 「盲按」次数多了说明策略在瞎撞，那是要模型介入的信号。
  'interact-prompt': 4,
  'interact-blind': 6,
  // 进入/离开「满屏青色网格」的隐藏房间。窗口给长一点：这种房间很小，
  // 进进出出不该刷出一串事件。
  'grid-room': 15,
  'grid-room-exit': 15,
}

/** 默认去重窗口（kind 没列出来的用它） */
const DEFAULT_DEDUPE = 3

/** 全项目的事件 kind（写在这里当唯一的权威清单，selfcheck 会核对） */
export const KINDS = Object.keys(DEDUPE_WINDOW)

/** 默认上限：超过就按等级从低到高丢 */
const DEFAULT_LIMIT = 200

const levelRank = (lv) => LEVELS.indexOf(lv)

/**
 * 事件日志。
 *
 * 用法：
 *   const log = new EventLog()
 *   log.push('damage', 'notable', '第 12s 掉血 8%', { from: 0.72, to: 0.64 })
 *   log.digest({ minLevel: 'notable' })   // → 摘要文字
 */
export class EventLog {
  /**
   * @param {{limit?: number}} [opts]
   */
  constructor(opts = {}) {
    this.limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT
    /** @type {Array<{at:number, kind:string, level:string, text:string, data:object, repeat:number}>} */
    this.items = []
  }

  get length() {
    return this.items.length
  }

  /**
   * 记一条事件。同 kind 在去重窗口内会**合并**到上一条（不新增）。
   *
   * 合并规则（2026-10-24 实战暴露的坑）：
   *   一开始是「文案取最新、等级取最高」，结果摘要里出现
   *   `[urgent] 跌 12%（此后又 3 次）` —— 12% 本身不是 urgent，
   *   是中间有一次 23% 把等级顶上去了，但文案又被后面那次 12% 覆盖了。
   *   等级和文案不一致比没有等级更糟，它会骗模型。
   *
   *   现在：传 severity（严重度数字）时**按 severity 比**，更严重的才替换文案；
   *   不传就退化用等级 rank 比。等级相同时保留最早那条（摘要不该被同级别的小波动来回改写）。
   *
   * @param {string} kind   事件类型（见 KINDS）
   * @param {string} level  info / notable / urgent
   * @param {string} text   给人看的一句话（已经拼好，不要再加工）
   * @param {object} [data] 结构化细节，供策略/统计用
   * @param {number} [at]   相对开始的时间（秒）；不传就沿用上一条的 at
   * @param {number} [severity] 严重度（越大越严重）；不传就用等级 rank
   */
  push(kind, level, text, data = {}, at = null, severity = null) {
    if (!KINDS.includes(kind)) {
      // 不认识的 kind 不静默吞掉：当成 info 记下来，方便发现拼错
      level = levelRank(level) >= 0 ? level : 'info'
      kind = String(kind)
    }
    const safeLevel = levelRank(level) >= 0 ? level : 'info'
    const now = Number.isFinite(at) ? at : (this.items.length ? this.items[this.items.length - 1].at : 0)
    const win = DEDUPE_WINDOW[kind] ?? DEFAULT_DEDUPE
    const sev = Number.isFinite(severity) ? severity : levelRank(safeLevel)

    // 找窗口内最后一条同类事件 → 合并
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i]
      if (now - e.at > win) break // 时间更早的更不可能在窗口内，早退
      if (e.kind !== kind) continue
      const prevSev = Number.isFinite(e._sev) ? e._sev : levelRank(e.level)
      e.at = now
      e.repeat += 1
      if (sev > prevSev) {
        // 这次更严重：文案、等级、数据都换成这次的
        e.level = safeLevel
        e.text = text
        e.data = { ...e.data, ...data }
        e._sev = sev
      } else {
        // 没这次严重：只记下最新一次的数据，文案不动（否则摘要会被小波动改写）
        e.data = { ...e.data, last: { ...data, at: now } }
      }
      return e
    }

    const item = { at: now, kind, level: safeLevel, text, data, repeat: 0, _sev: sev }
    this.items.push(item)
    this._trim()
    return item
  }

  /** 超限时按等级从低到高丢最老的一条（urgent 最后才丢） */
  _trim() {
    while (this.items.length > this.limit) {
      let victim = -1
      let victimRank = 99
      for (let i = 0; i < this.items.length; i++) {
        const r = levelRank(this.items[i].level)
        if (r < victimRank) { victimRank = r; victim = i }
      }
      if (victim < 0) break
      this.items.splice(victim, 1)
    }
  }

  /** 按 kind 数一下（给摘要里的「掉血 3 次」用） */
  count(kind) {
    return this.items.filter((e) => e.kind === kind).length
  }

  /** 取某个等级及以上的事件 */
  atLeast(minLevel = 'info') {
    const floor = levelRank(minLevel)
    return this.items.filter((e) => levelRank(e.level) >= floor)
  }

  /**
   * 生成给人看的摘要：先 urgent，再 notable，再 info（各组内按时间）。
   * @param {{minLevel?: string, max?: number}} [opts]
   * @returns {string} 多行文字；没有事件时返回空串
   */
  digest(opts = {}) {
    const minLevel = levelRank(opts.minLevel || 'info') >= 0 ? (opts.minLevel || 'info') : 'info'
    const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : 40
    const picked = this.atLeast(minLevel)
    if (!picked.length) return ''
    const order = ['urgent', 'notable', 'info']
    const lines = []
    for (const lv of order) {
      const group = picked.filter((e) => e.level === lv).slice(0, max)
      for (const e of group) {
        const tag = lv === 'urgent' ? 'urgent' : lv === 'notable' ? 'notable' : 'info'
        const repeat = e.repeat > 0 ? `（此后又 ${e.repeat} 次）` : ''
        lines.push(`[${tag}] ${e.text}${repeat}`)
      }
    }
    const dropped = picked.length - lines.length
    if (dropped > 0) lines.push(`（另有 ${dropped} 条常规事件未列出）`)
    return lines.join('\n')
  }

  /** 序列化成纯数据（跨回合存盘用）。_sev 是内部比较用的，不落盘。 */
  toJSON() {
    return {
      limit: this.limit,
      items: this.items.map(({ _sev, ...e }) => ({ ...e })),
    }
  }

  /** 从存盘数据恢复；坏数据不抛，返回空日志 */
  static fromJSON(raw) {
    const log = new EventLog({ limit: raw && Number.isFinite(raw.limit) ? raw.limit : undefined })
    if (!raw || !Array.isArray(raw.items)) return log
    for (const e of raw.items) {
      if (!e || typeof e !== 'object') continue
      if (typeof e.kind !== 'string') continue
      const level = levelRank(e.level) >= 0 ? e.level : 'info'
      log.items.push({
        at: Number.isFinite(e.at) ? e.at : 0,
        kind: e.kind,
        level,
        text: String(e.text || ''),
        data: e.data && typeof e.data === 'object' ? e.data : {},
        repeat: Number.isFinite(e.repeat) ? e.repeat : 0,
        _sev: levelRank(level), // 恢复后按等级估个严重度，够合并时比较
      })
    }
    log._trim()
    return log
  }
}

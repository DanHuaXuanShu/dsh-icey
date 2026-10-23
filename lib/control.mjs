/**
 * lib/control.mjs —— 语义动作 → 按键序列；单动作串行队列 + 冷却 + releaseAll
 * ============================================================================
 * 为什么要有这一层：agent 说「往右走 800ms」，不该自己拼 SendInput。
 * 这一层把语义动作翻译成「按住哪个键多久 / 点哪个键」，并且保证：
 *   - 同一时刻只有一个动作在按（ICEY 里同时按 a 和 d 会原地卡住）
 *   - 动作之间有冷却，避免连发把游戏输入队列打爆
 *   - 队列有上限，超过就拒（宁可丢也不排一队两分钟前的指令）
 *   - **任何异常 / 卸载 / 流关闭 / 看门狗都调 releaseAll**，绝不留卡住的键
 *
 * ⚠️ 键名是**字符串**，不是 vk：'a' / ' ' / 'Escape' / 'Enter' / 'ArrowUp'。
 *    转 vk 的事在 lib/win.mjs（要 MapVirtualKey / VkKeyScanW），这样这一层纯 JS 可测。
 * ============================================================================
 */
import { DEFAULT_KEYMAP } from './config.mjs'

export { DEFAULT_KEYMAP }

/** 每个动作要哪些参数、按住时长怎么定 */
export const ACTION_SPECS = {
  move: { args: ['dir', 'ms'], desc: '朝一个方向走（按住方向键 ms 毫秒）' },
  attack: { args: ['ms'], desc: '普通攻击（点 J，ms 毫秒）' },
  heavy: { args: ['ms'], desc: '重攻击（点 I）' },
  execute: { args: ['ms'], desc: '处决 / 终结技（点 L）—— 敌人冒黄圈+头顶 L 时用，回血回盾掉结晶' },
  overload: { args: ['ms'], desc: '长按 J 吸收能量结晶并释放超载（按住 1.2 秒）' },
  jump: { args: ['ms'], desc: '跳跃（点空格）' },
  dash: { args: ['dir', 'ms'], desc: '闪现/冲刺（O；按住方向键，默认右）' },
  chase: { args: ['dir', 'ms'], desc: '追击（U）—— 朝敌人方向突进，拉近距离用' },
  combo: { args: ['keys'], desc: '连段：按给定键序列出招（如 jjjji = J→J→J→J→I）' },
  storm: { args: ['ms'], desc: '强化技·湍流（键 8）—— 过载旋风，免疫伤害' },
  shade: { args: ['ms'], desc: '强化技·流场（键 9）—— 过载分身斩，需在强化台解锁' },
  interact: { args: ['ms'], desc: '互动 / 确认（点 Enter）' },
  menu: { args: ['item'], desc: '菜单项：resume（恢复游戏）/ exit / back' },
  pause: { args: [], desc: '暂停 / 恢复（Esc）' },
}

/** 按住时长的默认值与上下限（毫秒） */
const HOLD = { min: 40, max: 5000, attack: 120, move: 500, jump: 80, menu: 60 }
/** 动作之间的冷却：上一条动作结束后至少隔这么久才发下一条 */
const COOLDOWN_MS = 90
/** 队列上限：超过就拒，不排队 */
const MAX_QUEUE = 3
/** 动作进队列后超过这么久还没开始执行就作废（避免「两分钟前点的那一刀」） */
const STALE_MS = 2000

const DIRS = {
  up: 'moveUp',
  down: 'moveDown',
  left: 'moveLeft',
  right: 'moveRight',
}

function clampHold(ms, fallback) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(HOLD.max, Math.max(HOLD.min, Math.round(n)))
}

function dirKey(dir, keyMap) {
  const slot = DIRS[String(dir || '').toLowerCase()]
  if (!slot) throw new Error(`方向不认识：${dir}（可用 up / down / left / right）`)
  return keyMap[slot]
}

/**
 * 把语义动作翻成一个按键序列。
 * @param {{action: string, dir?: string, ms?: number, item?: string}} input
 * @param {{keyMap?: Record<string,string>}} [opts]
 * @returns {{action: string, steps: {key: string, holdMs: number, label: string}[], desc: string}}
 */
export function planAction(input, opts = {}) {
  const keyMap = { ...DEFAULT_KEYMAP, ...(opts.keyMap || {}) }
  const action = String(input?.action || '')
  if (!(action in ACTION_SPECS)) {
    throw new Error(`动作不认识：${action || '(空)'}（可用 ${Object.keys(ACTION_SPECS).join(' / ')}）`)
  }
  const tap = (key, ms, label) => ({ steps: [{ key, holdMs: clampHold(ms, HOLD.attack), label }], desc: label })

  switch (action) {
    case 'move': {
      const key = dirKey(input.dir, keyMap)
      const ms = clampHold(input.ms, HOLD.move)
      return { action, steps: [{ key, holdMs: ms, label: `按住 ${key} ${ms}ms` }], desc: `往${input.dir}走 ${ms}ms` }
    }
    case 'dash': {
      const key = dirKey(input.dir || 'right', keyMap)
      const ms = clampHold(input.ms, 180)
      return { action, steps: [{ key, holdMs: ms, label: `按住 ${key} ${ms}ms` }], desc: `往${input.dir || 'right'}冲刺` }
    }
    case 'chase': {
      // 追击是「方向 + U」：先往目标方向按住，再点 U
      const key = dirKey(input.dir || 'right', keyMap)
      const ms = clampHold(input.ms, 260)
      return {
        action,
        steps: [
          { key, holdMs: ms, label: `按住 ${key} ${ms}ms` },
          { key: keyMap.chase, holdMs: 60, label: `点 ${keyMap.chase}（追击）` },
        ],
        desc: `往${input.dir || 'right'}追击`,
      }
    }
    case 'attack':
      return { action, ...tap(keyMap.attack, input.ms, `点 ${keyMap.attack}`) }
    case 'heavy':
      return { action, ...tap(keyMap.heavy, input.ms, `点 ${keyMap.heavy}`) }
    case 'combo': {
      // 按序列出招：每个字符一键，每键按住 70ms —— 连段要在硬直窗口内接上。
      // 支持：j=攻击 i=重击 l=处决 u=追击 8=湍流 9=流场
      //       w=上(配合 J 就是「激发」挑空) s=下(配合 J 就是「凝滞」空中定身)
      //       '_' = 该键长按（如 jjjji_ 表示最后一下重击按住）
      const raw = String(input.keys || 'jjj').toLowerCase().replace(/[^jilu89ws_]/g, '')
      const chars = raw.split('').filter(Boolean)
      if (!chars.length) return { action, steps: [{ key: keyMap.attack, holdMs: 70, label: '点 ' + keyMap.attack }], desc: '连段（空序列→普攻）' }
      const map = {
        j: keyMap.attack, i: keyMap.heavy, l: keyMap.execute, u: keyMap.chase,
        '8': keyMap.storm, '9': keyMap.shade, w: keyMap.moveUp, s: keyMap.moveDown,
      }
      const steps = chars.map((c) => {
        if (c === '_') return null
        return { key: map[c] || keyMap.attack, holdMs: 70, label: '点 ' + (map[c] || keyMap.attack) }
      }).filter(Boolean)
      // 下划线表示「上一键长按」：把前一步的 holdMs 拉长
      let holdNext = false
      const origLen = chars.length
      for (let i = 0; i < chars.length; i++) {
        if (chars[i] === '_' && i > 0) { holdNext = true; break }
      }
      if (holdNext) {
        // 简单处理：出现 '_' 就把最后一个动作的按住时长延长到 900ms
        steps[steps.length - 1].holdMs = 900
        steps[steps.length - 1].label += '（长按）'
      }
      return {
        action,
        steps,
        desc: '连段 ' + chars.filter((c) => c !== '_').map((c) => (map[c] || keyMap.attack).toUpperCase()).join('→'),
      }
    }
    case 'storm':
      return { action, ...tap(keyMap.storm, input.ms, `点 ${keyMap.storm}（湍流）`) }
    case 'shade':
      return { action, ...tap(keyMap.shade, input.ms, `点 ${keyMap.shade}（流场）`) }
    case 'overload': {
      // 长按 J：先吸能量结晶，满能后释放超载（招式表里「超载」就是 J 长按）
      const holdMs = Math.max(600, Math.min(2500, input.ms || 1200))
      return { action, steps: [{ key: keyMap.attack, holdMs, label: `按住 ${keyMap.attack} ${holdMs}ms（吸收+超载）` }], desc: '长按 J 吸收 → 释放超载' }
    }
    case 'execute':
      return { action, ...tap(keyMap.execute, input.ms, `点 ${keyMap.execute}`) }
    case 'jump':
      return { action, ...tap(keyMap.jump, input.ms ?? HOLD.jump, `点 ${keyMap.jump === ' ' ? '空格' : keyMap.jump}`) }
    case 'interact':
      return { action, ...tap('Enter', input.ms, '点 Enter') }
    case 'pause':
      return { action, ...tap('Escape', input.ms, '点 Esc') }
    case 'menu': {
      const item = String(input.item || 'resume').toLowerCase()
      if (item === 'resume') return { action, ...tap('Enter', input.ms, '点 Enter（恢复游戏）') }
      if (item === 'back') return { action, ...tap('Escape', input.ms, '点 Esc（返回）') }
      if (item === 'exit') {
        // 暂停菜单里「退出」在「恢复游戏」下面一格：下 + Enter
        return {
          action,
          steps: [
            { key: 'ArrowDown', holdMs: HOLD.menu, label: '下' },
            { key: 'Enter', holdMs: HOLD.menu, label: '点 Enter（退出）' },
          ],
          desc: '菜单里选「退出」',
        }
      }
      throw new Error(`菜单项不认识：${input.item}（可用 resume / exit / back）`)
    }
    default:
      throw new Error(`动作不认识：${action}`)
  }
}

/**
 * 单动作串行队列。
 * run(job) 负责真的按键（由 lib/win.mjs 提供）；releaseAll() 负责松开所有键。
 */
export class ActionQueue {
  constructor(opts = {}) {
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE
    this.staleMs = opts.staleMs ?? STALE_MS
    this.run = opts.run ?? (async () => {})
    this.releaseAll = opts.releaseAll ?? (async () => {})
    this.pending = []
    this.busy = false
    this.disposed = false
    this.seq = 0
    this.lastDoneAt = 0
    this.stats = { done: 0, failed: 0, rejected: 0, stale: 0 }
  }

  get depth() { return this.pending.length }

  /**
   * 排队一个动作。立即返回受理结果（不等执行完）。
   * @returns {Promise<{accepted: boolean, id: string, reason?: string}>}
   */
  async push(job) {
    const id = `act-${++this.seq}`
    if (this.disposed) {
      this.stats.rejected++
      return { accepted: false, id, reason: '插件已停止（游戏没在跑），动作没有执行' }
    }
    if (this.pending.length >= this.maxQueue) {
      this.stats.rejected++
      return { accepted: false, id, reason: `动作队列满了（上限 ${this.maxQueue} 个），这一条没有执行` }
    }
    // qid 是队列自己的编号；调用方传进来的字段（id / plan 等）原样保留
    const entry = { ...job, qid: id, at: Date.now() }
    this.pending.push(entry)
    void this.#pump()
    return { accepted: true, id }
  }

  async #pump() {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      while (this.pending.length && !this.disposed) {
        const job = this.pending.shift()
        // 排太久了：作废（宁可丢，也不要在用户已经看向别处时突然按键）
        if (Date.now() - job.at > this.staleMs) {
          this.stats.stale++
          continue
        }
        const since = Date.now() - this.lastDoneAt
        if (since < this.cooldownMs) await sleep(this.cooldownMs - since)
        if (this.disposed) break
        try {
          await this.run(job)
          this.stats.done++
        } catch (err) {
          this.stats.failed++
          // 单个动作失败不能让键卡住
          await this.releaseAll().catch(() => {})
          job.onError?.(err)
        }
        this.lastDoneAt = Date.now()
      }
    } finally {
      this.busy = false
    }
  }

  /** 停止：清空队列、松开所有键、拒绝之后的新动作 */
  async dispose() {
    this.disposed = true
    this.pending.length = 0
    await this.releaseAll().catch(() => {})
    this.busy = false
  }

  /** 临时恢复（重新 attach 到游戏时用） */
  revive() {
    this.disposed = false
  }

  snapshot() {
    return { depth: this.pending.length, busy: this.busy, ...this.stats }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

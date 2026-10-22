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
  execute: { args: ['ms'], desc: '处决 / 终结技（点 L）' },
  jump: { args: ['ms'], desc: '跳跃（点空格）' },
  dash: { args: ['dir', 'ms'], desc: '朝一个方向冲刺（按住方向键，默认右）' },
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
    case 'attack':
      return { action, ...tap(keyMap.attack, input.ms, `点 ${keyMap.attack}`) }
    case 'heavy':
      return { action, ...tap(keyMap.heavy, input.ms, `点 ${keyMap.heavy}`) }
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

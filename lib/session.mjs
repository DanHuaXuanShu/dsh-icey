/**
 * lib/session.mjs —— 整个进程共用一个 GameSession
 * ============================================================================
 * 为什么要有这个模块：宿主半（index.js，路由）和 agent 半（agent.js，工具）是
 * **两个 Cordis 插件行**，但必须操作**同一局游戏**。Node 的模块缓存保证
 * 两边 import 同一个 lib/game.mjs 时拿到同一个实例 —— 所以把单例放这儿。
 *
 * 配置怎么进来：index.js 的 apply(ctx, config) 里把「现读配置」的函数装进来
 * （config 里每个字段是 volatile Cell，.get() 拿的是设置页改过之后的新值）。
 * ============================================================================
 */
import { GameSession } from './game.mjs'

/** @type {GameSession | null} */
let current = null
/** @type {() => Record<string, any>} */
let configProvider = () => ({})
/** @type {((spec: object) => any) | null} */
let spawner = null
let logger = null

/** index.js 在 apply 里调：装上「现读配置」+ 启动进程的能力 */
export function configure({ getConfig, spawnProcess, log } = {}) {
  if (getConfig) configProvider = getConfig
  if (spawnProcess) spawner = spawnProcess
  if (log) logger = log
}

export function session() {
  if (!current) {
    current = new GameSession({
      getConfig: () => configProvider(),
      spawnProcess: spawner ? (spec) => spawner(spec) : null,
      log: (m) => { try { logger?.(m) } catch { /* 日志失败不影响游戏 */ } },
    })
  }
  return current
}

/** 卸载 / 重载：松键、关 worker，绝不留卡住的键 */
export async function shutdown(reason = 'plugin unload') {
  if (!current) return
  const s = current
  current = null
  await s.dispose(reason).catch(() => {})
}

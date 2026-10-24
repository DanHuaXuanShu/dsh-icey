/**
 * lib/run-history.mjs —— 最近几轮连玩的记录（跨调用记忆）
 * ============================================================================
 * 解决什么：`icey_play` 是一个个独立的工具调用，模型每次都是"第一次看到这个世界"。
 *   上一轮干了什么、卡在哪儿、掉了多少血，全都丢了。于是它会重复同样的错。
 *
 * 只留最近 3 轮，而且只存**摘要级**的东西（事件摘要 + 计数 + 动作统计），
 * 不存原始帧 —— 存帧会让文件迅速膨胀，而且模型也用不上。
 *
 * 写盘用「临时文件 + rename」：半截 JSON 会在下次启动时读崩（同 lib/store.mjs 的做法）。
 * 任何失败都静默 —— 记忆是增强项，不能因为它写不进去就让连玩中断。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 只留最近几轮 */
const KEEP = 3

function homeDir() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'icey')
}

export function historyPath() {
  return join(homeDir(), 'last-runs.json')
}

/** 读所有记录；文件不存在或坏了都返回 [] */
export function loadRuns() {
  const file = historyPath()
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : []
  } catch {
    return []
  }
}

/**
 * 存一轮记录（自动只留最近 KEEP 轮）。
 * @param {object} entry
 * @returns {{ok:boolean, error?:string}}
 */
export function saveRun(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'entry 不是对象' }
  const file = historyPath()
  try {
    const runs = loadRuns()
    runs.push(entry)
    while (runs.length > KEEP) runs.shift()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(runs, null, 1)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 最近一轮（没有就 null） */
export function previousRun() {
  const runs = loadRuns()
  return runs.length ? runs[runs.length - 1] : null
}

/** 把一条记录压成一行给人看的文字 */
export function describeRun(run) {
  if (!run || typeof run !== 'object') return ''
  const parts = []
  if (run.at) parts.push(String(run.at).replace('T', ' ').slice(0, 16))
  if (Number.isFinite(run.seconds)) parts.push(`${Math.round(run.seconds)}s`)
  if (run.preset) parts.push(run.preset)
  if (run.stopped) parts.push(`停因 ${run.stopped}`)
  if (run.eventDigest) {
    const notable = String(run.eventDigest).split('\n').filter((l) => /urgent|notable/.test(l)).slice(0, 3)
    if (notable.length) parts.push(notable.join('；'))
  }
  return parts.join('｜')
}

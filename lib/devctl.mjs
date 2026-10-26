/**
 * lib/devctl.mjs —— 开发期自检与「让改动生效」的小工具层（给 `icey_dev` 工具用）
 * ============================================================================
 * 为什么需要它：
 *   这个插件的逻辑在 lib/ 里，而 lib/ 是**进程启动时**被 import 的 ESM。
 *   改完 lib 不给插件重新加载，跑的还是旧代码 —— 2026-10-26 就踩过：
 *   加了 face 动作、修了连击停滞的 bug，结果 `icey_play` 还是抽搐版，日志写着旧文案。
 *   用户每次都得去 GUI 设置里关一下再开一下，这不该是人干的活。
 *
 * 三个动作，按安全程度排序：
 *   stamp  —— 只读。列出「进程启动之后被改过的代码文件」。这一条永远安全，先看它。
 *   probe  —— 只读。把 Cordis 上下文的可用面（keys / 服务 / registry）导出成 JSON，
 *             用来**先看清楚有什么**，再决定怎么重载。不做任何副作用。
 *   reload —— 有副作用。按候选策略依次尝试让插件重新加载；每次尝试都写日志。
 *
 * ⚠️ 诚实标注：reload 用的 Cordis 内部接口是**推断**出来的（`ctx.get()` 服务名、
 *    `ctx.root.registry`），没有 DSH 官方文档背书。所以它：
 *      1. 默认只探不卸（`apply !== true` 时一个字节都不动）；
 *      2. 每一步都写进日志文件，失败也能看出失败在哪一步；
 *      3. 绝不 dispose 自己所在的 scope 而不知道能不能重建 —— 那会把工具全弄没。
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** 插件根目录（lib/ 的上一级） */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 这些目录里的东西不算「插件代码」，扫它们没意义还慢 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'shots', 'probe', 'locale', 'workbuddy', 'dist', '.github'])

/** 进程启动时刻（毫秒）。用它来判断「文件是不是进程起来之后才改的」 */
export function processStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000)
}

/** 列出插件自己的代码文件（index.js / agent.js / client.js / lib/**.mjs） */
export function codeFiles() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(mjs|js)$/.test(name)) continue
      out.push({
        rel: relative(PLUGIN_ROOT, full).replaceAll('\\', '/'),
        mtime: Math.round(st.mtimeMs),
        size: st.size,
      })
    }
  }
  walk(PLUGIN_ROOT, 0)
  return out.sort((a, b) => a.mtime - b.mtime)
}

/**
 * 「改了哪些、改了会不会生效」的报告。
 * 判据：文件 mtime > 进程启动时刻 ⇒ 这份代码是进程起来之后才写的，当前进程里跑的不是它。
 */
export function stampReport() {
  const startedAt = processStartedAt()
  const files = codeFiles()
  const stale = files.filter((f) => f.mtime > startedAt)
  const lines = []
  lines.push(`插件根目录：${PLUGIN_ROOT}`)
  lines.push(`进程启动于：${new Date(startedAt).toLocaleString('zh-CN')}（已跑 ${Math.round(process.uptime())} 秒）`)
  lines.push(`代码文件 ${files.length} 个，其中 ${stale.length} 个是启动之后改的。`)
  if (!stale.length) {
    lines.push('⇒ 没有未生效的改动，现在跑的就是磁盘上的代码。')
  } else {
    lines.push('⇒ 下面这些改动**当前进程里没生效**（要重载插件才会跑新代码）：')
    for (const f of stale) lines.push(`   · ${f.rel}（${new Date(f.mtime).toLocaleTimeString('zh-CN')}，${f.size} 字节）`)
  }
  return { startedAt, files, stale, text: lines.join('\n') }
}

/** 安全地取一个属性（Cordis 的 Context 上很多 getter 会抛） */
function safeGet(obj, key) {
  try { return obj[key] } catch (e) { return `‹抛错：${e?.message || e}›` }
}

/**
 * 把 ctx 的可操作面导成纯 JSON。**只读**，不做任何副作用。
 * 目标是回答一个问题：有没有一个「能重载插件」的入口。
 */
export function describeCtx(ctx) {
  const safe = (value) => {
    if (value === null || value === undefined) return value
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') return value
    if (t === 'function') return `⟨function ${value.name || 'anonymous'}⟩`
    if (Array.isArray(value)) return `⟨array ${value.length}⟩`
    return `⟨object⟩`
  }

  const info = { ownKeys: [], protoKeys: [], services: [], registries: {}, notes: [] }

  for (const k of Object.keys(ctx)) info.ownKeys.push(k)
  const proto = Object.getPrototypeOf(ctx)
  if (proto) info.protoKeys = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor')

  // 服务名：Cordis 的注册表通常挂在 root / registry 上
  const root = safeGet(ctx, 'root')
  const registry = safeGet(root && root !== '‹抛错›' ? root : ctx, 'registry')
  const tryRegistry = (label, reg) => {
    if (!reg || typeof reg !== 'object') { info.registries[label] = `‹没有或不是对象：${typeof reg}›`; return }
    const keys = []
    try {
      for (const k of Object.keys(reg)) keys.push(k)
    } catch { /* ignore */ }
    info.registries[label] = { keys }
  }
  tryRegistry('ctx.registry', safeGet(ctx, 'registry'))
  tryRegistry('root.registry', registry)

  // 常见服务名逐个点一遍（get 不存在会返回 undefined 或抛，都兜住）
  const candidates = ['tools', 'attachments', 'connection', 'pluginManager', 'plugins', 'market', 'loader', 'scope', 'registry']
  for (const name of candidates) {
    let v
    try { v = typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch (e) { v = `‹抛错：${e?.message || e}›` }
    if (v === undefined) continue
    const entry = { name, type: typeof v }
    if (v && typeof v === 'object') {
      entry.keys = []
      try { entry.keys = Object.keys(v) } catch { /* ignore */ }
      entry.methods = []
      try {
        for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {})) {
          if (k === 'constructor') continue
          try { if (typeof v[k] === 'function') entry.methods.push(k) } catch { /* getter throws */ }
        }
      } catch { /* ignore */ }
    }
    info.services.push(entry)
  }

  // scope / dispose 这些决定「能不能自卸」的东西
  for (const k of ['scope', 'dispose', 'effect', 'plugin', 'inject']) {
    info.notes.push(`${k}: ${safe(safeGet(ctx, k))}`)
  }

  return info
}

/** 日志文件：$DSH_HOME/icey/devctl.log（DSH_HOME 缺省用 ~/.dsh） */
export function logPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'icey')
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return join(dir, 'devctl.log')
}

export function appendLog(lines) {
  const path = logPath()
  const stamp = `\n===== ${new Date().toISOString()} =====\n`
  try { writeFileSync(path, stamp + lines.join('\n') + '\n', { flag: 'a' }) } catch { /* ignore */ }
  return path
}

export function readLog(maxChars = 4000) {
  const path = logPath()
  if (!existsSync(path)) return '（还没有日志）'
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch (e) { return `读不到日志：${e?.message || e}` }
  return text.length > maxChars ? `…（前略）\n${text.slice(-maxChars)}` : text
}

/**
 * 尝试让插件重新加载。
 *
 * ⚠️ 设计上**只做「请 DSH 自己重载」这一件事**，绝不自己 dispose 自己 ——
 *   自卸之后如果没能重建，工具就全没了，那时连报错都发不出去。
 *
 * @param {object} ctx  插件上下文（apply 收到的那个）
 * @param {{apply:boolean}} opts apply=false 只探不卸
 */
export async function attemptReload(ctx, opts = {}) {
  const apply = opts.apply === true
  const log = []
  log.push(apply ? '模式：apply（会真的触发重载）' : '模式：probe（不触发任何重载，只看有没有入口）')

  const found = []
  for (const name of ['pluginManager', 'plugins', 'market', 'loader']) {
    let svc
    try { svc = typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch (e) { svc = undefined }
    if (!svc) continue
    const methods = []
    try {
      for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(svc) || {})) {
        if (k === 'constructor') continue
        let v
        try { v = svc[k] } catch { continue }
        if (typeof v === 'function') methods.push(k)
      }
    } catch { /* ignore */ }
    // 也把自有属性上的函数算进去（有的服务是普通对象）
    for (const k of Object.keys(svc)) {
      try { if (typeof svc[k] === 'function') methods.push(k) } catch { /* ignore */ }
    }
    found.push({ name, methods: [...new Set(methods)] })
    log.push(`服务 ${name} 可用，方法：${[...new Set(methods)].join(', ') || '（没有函数）'}`)
  }

  if (!found.length) {
    log.push('没找到任何插件管理器服务。')
    log.push('⇒ 结论：这个 DSH 版本里，插件重载只能从 GUI 的设置-插件页触发，插件内部没有入口。')
    if (apply) log.push('（apply 模式也没能做什么 —— 找不到入口，硬调只会报错。）')
    const path = appendLog(log)
    return { ok: false, reason: 'no-plugin-manager', log: log.join('\n'), path }
  }

  if (!apply) {
    log.push('⇒ probe 模式到此为止。确认上面哪个服务/方法靠谱之后，再带 apply=true 调一次。')
    const path = appendLog(log)
    return { ok: true, probed: found, log: log.join('\n'), path }
  }

  // 真去重载：只认「看起来就是做这件事」的方法名，不乱猜
  const RANK = ['reload', 'restart', 'enable', 'toggle', 'reloadPlugin', 'restartPlugin']
  for (const svc of found) {
    for (const rank of RANK) {
      const method = svc.methods.find((m) => m.toLowerCase() === rank.toLowerCase())
      if (!method) continue
      log.push(`尝试 ${svc.name}.${method}('dsh-icey') …`)
      try {
        const ret = await ctx.get(svc.name)[method]('dsh-icey')
        log.push(`调用返回：${JSON.stringify(ret) ?? 'undefined'}（成功与否看下一次 icey_dev stamp）`)
        const path = appendLog(log)
        return { ok: true, called: `${svc.name}.${method}`, ret, log: log.join('\n'), path }
      } catch (e) {
        log.push(`抛错：${e?.message || e}`)
      }
    }
  }
  log.push('服务都在，但没有一个方法名像是「重载某个插件」。为了不乱动，什么都没调。')
  const path = appendLog(log)
  return { ok: false, reason: 'no-obvious-method', probed: found, log: log.join('\n'), path }
}

/** 跑 selfcheck，返回尾部输出（开发期最常用的那一句「多少项过」） */
export async function runSelfcheck() {
  const { spawn } = await import('node:child_process')
  const script = join(PLUGIN_ROOT, 'selfcheck.mjs')
  if (!existsSync(script)) return { ok: false, error: `找不到 ${script}` }
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: PLUGIN_ROOT, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('close', (code) => {
      const tail = out.split('\n').filter((l) => l.trim()).slice(-6).join('\n')
      resolve({ ok: code === 0, code, tail, stderr: err.slice(-800) })
    })
    child.on('error', (e) => resolve({ ok: false, error: e?.message || String(e) }))
  })
}

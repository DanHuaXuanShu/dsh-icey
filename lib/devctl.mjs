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

/**
 * 本模块被 import 的时刻 —— 也就是「当前这份插件代码是什么时候装进进程的」。
 *
 * 🔴 为什么不用 `process.uptime()`：那量的是 **DSH 主进程**的启动时间，
 *    而插件重载**不会重启主进程**。2026-10-26 第一版就是这么写错的，
 *    结果插件明明刚重载过，它还在报「11 个文件没生效」—— 全都误导。
 *
 * 🔴 2026-10-31 又修一次：光靠「模块求值时刻」**仍然会误报**。
 *    ESM 在同一进程里按 URL 缓存，模块不一定会因为「插件重载」而重新求值；
 *    实测过：手动 reload 之后插件行为已经变了（新代码在跑），但 stamp 读到的
 *    基准还停在首次求值那一刻，于是它一直报「6 个文件装载之后才改」。
 *    一个会误报的检查器比没有检查器更坏 —— 它会让你怀疑本来正确的东西。
 *
 *    修法：基准不再是常量，而是「每次插件激活时刷新」。
 *    `apply()` 一定会重新执行（那是插件被启用的入口），所以在那儿调用 markLoaded()，
 *    取「模块求值」和「apply 执行」两个时刻里较晚的那个。
 */
let LOADED_AT = Date.now()

/**
 * 记一次「这份代码从现在起在跑」。由插件的 apply() 调用。
 * 只往晚了推，不会把基准往回拨。
 * @param {number} [at] 默认现在
 * @returns {number} 更新后的基准
 */
export function markLoaded(at = Date.now()) {
  if (Number.isFinite(at) && at > LOADED_AT) LOADED_AT = at
  return LOADED_AT
}

/** 当前基准（毫秒）。stamp 用它判断「文件是不是比代码新」 */
export function getLoadedAt() {
  return LOADED_AT
}

/** 这些目录里的东西不算「插件代码」，扫它们没意义还慢 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'shots', 'probe', 'locale', 'workbuddy', 'dist', '.github'])

/** 进程启动时刻（毫秒）。只作参考 —— 判断「代码有没有生效」要用 LOADED_AT，不是它 */
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
  const base = getLoadedAt()
  const stale = files.filter((f) => f.mtime > base)
  const lines = []
  lines.push(`插件根目录：${PLUGIN_ROOT}`)
  lines.push(`插件代码装载于：${new Date(base).toLocaleString('zh-CN')}（≈${Math.round((Date.now() - base) / 1000)} 秒前）`)
  lines.push(`DSH 主进程启动于：${new Date(startedAt).toLocaleString('zh-CN')}（仅供参考：插件重载不会重启它）`)
  lines.push(`代码文件 ${files.length} 个，其中 ${stale.length} 个是**装载之后**才改的。`)
  if (!stale.length) {
    lines.push('⇒ 没有未生效的改动，现在跑的就是磁盘上的代码。')
  } else {
    lines.push('⇒ 下面这些改动**当前进程里没生效**（要重载插件才会跑新代码）：')
    for (const f of stale) lines.push(`   · ${f.rel}（${new Date(f.mtime).toLocaleTimeString('zh-CN')}，${f.size} 字节）`)
    // 🔴 2026-10-31：这个结论依赖「装载时刻」这个基准。基准没跟着重载刷新时它会误报，
    //    所以结论后面必须带一句替代验证法 —— 不能让人无条件相信一个可能过期的判断。
    lines.push('')
    lines.push('⚠️ 上面这条结论**依赖「装载时刻」这个基准是准的**。如果显示的时间和你手动重载的时间对不上，')
    lines.push('   说明基准没刷新，这条结论不可信 —— 改用行为验证：看首帧尺寸（裁过标题栏是精确 16:9）、')
    lines.push('   或某个读数有没有跟着你的改动变。别只信 stamp。')
  }
  return { startedAt, loadedAt: base, files, stale, text: lines.join('\n') }
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
  const candidates = ['tools', 'attachments', 'connection', 'pluginManager', 'plugins', 'market', 'loader', 'scope', 'registry', 'hmr']
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
      // 把「可能用来重载」的那几个函数的**签名和源码开头**捞出来。
      // 光知道方法名没用 —— 要看清它收不收参数、收什么，才敢调。
      entry.signatures = []
      for (const m of entry.methods) {
        if (!/reload|restart|enable|inspect|publishAndReload|change|exclusive/i.test(m)) continue
        let fn
        try { fn = v[m] } catch { continue }
        if (typeof fn !== 'function') continue
        let src = ''
        try { src = String(fn).replace(/\s+/g, ' ').slice(0, 260) } catch { /* ignore */ }
        entry.signatures.push({ name: m, arity: fn.length, src })
      }
    }
    info.services.push(entry)
  }

  // ctx.fiber —— 2026-10-26 实测：`pluginManager.reload()` 抛
  // 「HMR profile reconciliation must run inside runExclusive」，
  // 说明重载必须在一个互斥区里跑。锁最可能挂在这上面，所以单独展开。
  {
    const fiber = safeGet(ctx, 'fiber')
    const entry = { name: 'ctx.fiber', type: typeof fiber }
    if (fiber && typeof fiber === 'object') {
      const proto = Object.getPrototypeOf(fiber)
      entry.protoMethods = []
      try {
        for (const k of Object.getOwnPropertyNames(proto || {})) {
          if (k === 'constructor') continue
          try { if (typeof fiber[k] === 'function') entry.protoMethods.push(k) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      entry.ownKeys = Object.keys(fiber)
      entry.signatures = []
      for (const m of entry.protoMethods) {
        if (!/exclusive|reload|update|sync/i.test(m)) continue
        let fn
        try { fn = fiber[m] } catch { continue }
        if (typeof fn !== 'function') continue
        let src = ''
        try { src = String(fn).replace(/\s+/g, ' ').slice(0, 260) } catch { /* ignore */ }
        entry.signatures.push({ name: m, arity: fn.length, src })
      }
    } else {
      entry.note = String(fiber)
    }
    info.fiber = entry
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
  //
  // 🔴 2026-10-26 实测（这条很重要）：`pluginManager.reload('dsh-icey')` 存在，
  //    但直接调会抛 `HMR profile reconciliation must run inside runExclusive` ——
  //    它必须在一个互斥区里跑。锁最可能挂在 `ctx.fiber` 上（ctx 的自有键里就有 fiber）。
  //    所以这里先找锁，找到就包着调，找不到就照直调并把这个错原样报出来。
  const fiber = safeGet(ctx, 'fiber')
  let lock = null
  let lockName = ''
  for (const [holder, label] of [[fiber, 'ctx.fiber'], [ctx, 'ctx'], [safeGet(ctx, 'root'), 'ctx.root']]) {
    if (!holder || typeof holder !== 'object') continue
    for (const name of ['runExclusive', 'exclusive', 'update']) {
      let fn
      try { fn = holder[name] } catch { continue }
      if (typeof fn === 'function') { lock = fn.bind(holder); lockName = `${label}.${name}`; break }
    }
    if (lock) break
  }
  log.push(lock ? `找到互斥锁：${lockName}` : '没找到 runExclusive 那类互斥锁（会照直调，可能被拒）')

  const errors = []
  const RANK = ['reload', 'restart', 'publishAndReload', 'enable', 'toggle', 'reloadPlugin', 'restartPlugin']
  for (const svc of found) {
    for (const rank of RANK) {
      const method = svc.methods.find((m) => m.toLowerCase() === rank.toLowerCase())
      if (!method) continue
      const call = async () => ctx.get(svc.name)[method]('dsh-icey')
      const how = lock ? `${lockName}(() => ${svc.name}.${method}('dsh-icey'))` : `${svc.name}.${method}('dsh-icey')`
      log.push(`尝试 ${how} …`)
      try {
        const ret = lock ? await lock(call) : await call()
        log.push(`调用返回：${JSON.stringify(ret) ?? 'undefined'}（成功与否看下一次 icey_dev stamp）`)
        const path = appendLog(log)
        return { ok: true, called: how, ret, log: log.join('\n'), path }
      } catch (e) {
        const msg = String(e?.message || e)
        errors.push(`${svc.name}.${method}: ${msg}`)
        log.push(`抛错：${msg}`)
      }
    }
  }
  if (errors.length) {
    log.push('')
    log.push('⇒ 这些方法都存在、都被拒绝或抛错，不是「没有入口」。错误原文在上面，别丢。')
  } else {
    log.push('服务都在，但没有一个方法名像是「重载某个插件」。为了不乱动，什么都没调。')
  }
  const path = appendLog(log)
  return { ok: false, reason: errors.length ? 'all-calls-failed' : 'no-obvious-method', errors, probed: found, log: log.join('\n'), path }
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

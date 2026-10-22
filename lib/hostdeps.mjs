/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到"自己的依赖"）
 * ============================================================================
 * 🔴 为什么要有它（2026-10-16 一位用户递来的完整报告，本机也复现了）：
 *   `index.js` 顶部裸 import `@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools`，
 *   而它们在 package.json 里是 **optional peer** ⇒ 桌面版 profile（`autoInstallPeers: false`）
 *   **永远不装它们** ⇒ 插件整条不激活，DSH 只留一句
 *   `warning: 1 entry did not activate … failed to import` ✓
 *   （web profile 上之所以一直没事，是因为 profile 树里恰好有别的插件把它们 hoist 上来了 —— 这是运气 ✗）
 *   ⚠️ `dsh-tools` 自己还有 7 个顶层 import、其中 4 个是 peer ⇒ 光把它装上也救不回来 ✗。
 *
 * ⭐ 策略（两条一起走）：
 *   ① **优先从宿主那棵树里解析**（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 **bare import**（靠我们自己 package.json 的 `dependencies` 装一份保底）；
 *   ③ `schemastery` 彻底拿不到 ⇒ 返回 null，**插件照常加载**（只是没有 Config、设置页降级）——
 *      **绝不因为一个 import 就让整条插件不激活** ✗✓。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件自己那棵树（`dependencies` 装出来的那份）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    // 桌面版可能叫别的包名（dsh-desktop / dsh-next…）⇒ 逐个看它们的 node_modules
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 插件自己那份（package.json 的 dependencies 装出来的）—— 放最后，前面优先"跟宿主同一份"
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/** 试从宿主树里 import 一个包；拿不到返回 null（失败原因写进 notes，方便远程排查） */
async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue          // 自己那份交给下面的 bare import 处理
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/**
 * 兜底：这是**我们自己的等价实现**，只在拿不到宿主的 dsh-tools 时用。
 *
 * 🔴 它必须做一件事：把 dsh-tools 的 **spec 写法** 转成**合法 JSON Schema**。
 *   dsh-tools 的参数写法是「属性里写 `required: true`」：
 *       { action: { type: 'string', required: true, description: '...' } }
 *   但这**不是** JSON Schema —— 合法写法是对象级 `required: ['action']`。
 *   如果原样交给宿主校验器，就会报
 *       `icey_act schema 无效` / `required is not supported on type "string"`
 *   而且这个错误发生在**工具调用**时，插件看着是装好了的 —— 特别难查。
 *   （WorkBuddy 2026-10-21 的排查就是这条。）
 */
function normalizeParameters(params) {
  if (!params || typeof params !== 'object') {
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
  // 已经是标准 JSON Schema 就原样放过
  if (params.type === 'object' && params.properties) {
    return {
      type: 'object',
      properties: params.properties,
      required: Array.isArray(params.required) ? params.required : [],
      additionalProperties: params.additionalProperties ?? false,
    }
  }
  const properties = {}
  const required = []
  for (const [name, raw] of Object.entries(params)) {
    const spec = raw && typeof raw === 'object' ? { ...raw } : { type: 'string' }
    const isRequired = spec.required === true
    delete spec.required
    properties[name] = spec
    if (isRequired) required.push(name)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function localDefineTool(options, log) {
  // 宿主的 defineTool 会做 spec→JSONSchema 转换 + 参数校验；这里补上同样的转换。
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  const parameters = normalizeParameters(options.parameters)
  const output = options.output
    ? { ...options.output, schema: options.output.schema || { type: 'object', properties: {}, additionalProperties: true } }
    : undefined
  if (output?.schema && output.schema.type === 'object' && output.schema.additionalProperties === undefined) {
    output.schema = { ...output.schema, additionalProperties: true }
  }
  check(parameters, 'parameters')
  check(output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上（工具 ${options.name}）`)
  return { ...options, parameters, output }
}

/**
 * 取回宿主半端要用的一点点东西
 * @returns {Promise<{z:any, defineTool:Function|null, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  // ① schemastery（Config 要用；宿主设置层要用**它自己那份**读 volatile 字段）
  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`⚠️ schemastery 彻底拿不到（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）—— 这一份插件没有 Config，设置页会降级（插件本体照常跑）`) }
  }
  const z = zMod?.default ?? zMod ?? null

  // ② dsh-tools 的 defineTool（拿不到就用本地等价实现 —— 这是本次桌面版修复的关键一步）
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`); dtMod = null }
  }
  const hostDefineTool = dtMod?.defineTool || null
  const defineTool = hostDefineTool || ((options) => localDefineTool(options, log))
  // localFallback：调用方据此决定 `parameters` 传哪种写法（见下）
  //   宿主 defineTool 吃的是 **spec 写法**（属性里 `required: true`），它自己做 spec→JSON Schema；
  //   本地兜底吃的是 **合法 JSON Schema**（对象级 `required: [...]`）。
  //   把 spec 塞进宿主校验器 ⇒ `icey_act schema 无效`（2026-10-21 的报错就是这条）；
  //   把标准 schema 塞进宿主 defineTool ⇒ 被当成参数表再包一层（参数全错）。
  const localFallback = !hostDefineTool

  return { z, defineTool, localFallback, notes }
}

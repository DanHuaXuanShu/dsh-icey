/**
 * probe/apply-harness.mjs —— 用桩 ctx 真调 index.js 的 apply()
 *
 * 验三件事：
 *   ① 激活阶段不抛（抛了整条插件不装载，DSH 只留一句 warning）
 *   ② 有 tools/attachments 时，7 个 icey_* 工具被注册（合并成一行后靠 ctx.get 探测）
 *   ③ 没有 tools/attachments 时，**只跳过工具**，路由/配置照常 —— 优雅降级
 */
const calls = { routes: [], tools: [], effects: [], logs: [] }

function makeCtx({ withTools = true } = {}) {
  const ctx = {
    logger: {
      info: (m) => calls.logs.push(['info', m]),
      warn: (m) => calls.logs.push(['warn', m]),
      error: (m) => calls.logs.push(['error', m]),
    },
    effect(fn, label) {
      calls.effects.push(label)
      const dispose = fn()
      return () => { try { dispose?.() } catch { /* ignore */ } }
    },
    connection: {
      fetch: {
        register(route) {
          calls.routes.push({ path: route.path, methods: route.methods })
          return () => {}
        },
      },
    },
    get(name) {
      if (name === 'tools') return withTools ? ctx.tools : undefined
      if (name === 'attachments') return withTools ? ctx.attachments : undefined
      return ctx[name]
    },
    // Cordis 的可选依赖注入：服务齐了才回调（这里同步模拟）
    inject(deps, cb) {
      const ok = deps.every((d) => ctx.get(d) !== undefined)
      if (ok) cb(ctx)
      return () => {}
    },
  }
  if (withTools) {
    ctx.tools = {
      register(def) {
        calls.tools.push(def.name)
        return () => {}
      },
    }
    ctx.attachments = {
      imageLimits: { maxWidth: 1568, maxHeight: 1568 },
      async saveImages(inputs) {
        return inputs.map((_, i) => ({ id: `att-${i}`, mediaType: 'image/png' }))
      },
    }
  }
  return ctx
}

let failed = false
const host = await import('../index.js')
console.log('index.js 导入 OK；inject =', JSON.stringify(host.inject), '；Config =', host.Config ? '有' : '无')

/* ---------- ① 正常部署：应有 12 条路由 + 6 个工具 ---------- */
try {
  calls.routes.length = 0; calls.tools.length = 0; calls.effects.length = 0
  const ctx = makeCtx({ withTools: true })
  await host.apply(ctx, {})
  console.log('\n[有 tools/attachments]')
  console.log('  路由:', calls.routes.length, '条；工具:', calls.tools.length, '个 ->', calls.tools.join(', '))
  if (calls.routes.length !== 11) { failed = true; console.log('  ❌ 路由数不对，应为 11') }
  if (calls.tools.length !== 7) { failed = true; console.log('  ❌ 工具数不对，应为 7') }
} catch (e) {
  failed = true
  console.log('❌ [有 tools] apply 抛错：', e?.message)
  console.log(String(e?.stack || '').split('\n').slice(0, 8).join('\n'))
}

/* ---------- ② 缺工具的部署：路由照常、不抛错 ---------- */
try {
  calls.routes.length = 0; calls.tools.length = 0; calls.effects.length = 0
  const ctx = makeCtx({ withTools: false })
  await host.apply(ctx, {})
  console.log('\n[无 tools/attachments]')
  console.log('  路由:', calls.routes.length, '条；工具:', calls.tools.length, '个')
  if (calls.routes.length !== 11) { failed = true; console.log('  ❌ 路由被连累没注册') }
  if (calls.tools.length !== 0) { failed = true; console.log('  ❌ 没有 tools 服务却注册了工具') }
  const skipLog = calls.logs.find(([, m]) => /可选依赖方式注册/.test(m))
  console.log('  跳过说明:', skipLog ? '有 ✅' : '无 ❌')
  if (!skipLog) failed = true
} catch (e) {
  failed = true
  console.log('❌ [无 tools] apply 抛错：', e?.message)
}

/* ---------- ③ 检查 cordis.patch.yml 只剩一行 ---------- */
try {
  const fs = await import('node:fs')
  const yml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = yml.split('\n').filter((l) => /^\s*-\s*id:/.test(l))
  console.log('\ncordis.patch.yml 行数:', rows.length, '->', rows.map((l) => l.trim()).join(' | '))
  if (rows.length !== 1) { failed = true; console.log('  ❌ 应该只插一行（两行会让界面出现两个同名条目）') }
} catch (e) {
  failed = true
  console.log('读 cordis.patch.yml 失败:', e?.message)
}

console.log('\n日志:')
for (const [lvl, m] of calls.logs) console.log(`  [${lvl}] ${m}`)

await new Promise((r) => setTimeout(r, 300))
console.log(failed ? '\n❌ 有失败项' : '\n✅ 全部通过')
process.exit(failed ? 1 : 0)

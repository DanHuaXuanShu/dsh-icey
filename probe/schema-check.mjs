/**
 * probe/schema-check.mjs —— 用 **DSH 自己的** JSON Schema 子集校验器验注册出去的 6 个工具
 * ============================================================================
 * 为什么不再用手写校验器（2026-10-21 换掉）：
 *   `icey_act schema 无效` 是宿主 `dsh-tools/json-schema` 报的，它的规则比「属性里不许有
 *   required」多得多（type 白名单、required 必须是数组、additionalProperties 必须是布尔、
 *   enum/const 类型、oneOf 兄弟关键字、annotation 必须无损 JSON、不支持的关键字直接红）。
 *   手写版盖不全 ⇒ 假绿。现在直接用从 app.asar 切出来的宿主副本
 *   （probe/dsh-jsonschema.mjs，切法见它头部）。
 *
 * 验三件事：
 *   ① 6 个工具最终交给 ctx.tools.register 的 parameters / output.schema 过宿主校验器；
 *   ② 本地兜底路径产出的是**标准 JSON Schema**（对象级 required，属性里没有 required）；
 *   ③ 宿主 defineTool 路径产出的是**原样 spec**（属性里保留 required: true，由宿主自己转）。
 * 另加**灵敏度自证**：旧写法必须被这个校验器判红 —— 否则校验器接错了也是绿。
 * ============================================================================
 */
import { assertObjectJsonSchema, JsonSchemaError } from './dsh-jsonschema.mjs'

const problems = []

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  tools: { register(def) { checkAll(def); return () => {} } },
  attachments: { imageLimits: { maxWidth: 1568 }, async saveImages(i) { return i.map((_, n) => ({ id: n })) } },
}

const registered = []
function checkAll(def) {
  registered.push(def)
  for (const [what, schema] of [['parameters', def.parameters], ['output.schema', def.output?.schema]]) {
    if (!schema) { problems.push(`${def.name}.${what}: 缺失`); continue }
    try {
      assertObjectJsonSchema(schema)
    } catch (e) {
      problems.push(`${def.name}.${what}: ${e.message}`)
    }
  }
}

const agent = await import('../agent.js')
agent.apply(ctx)

console.log(`注册了 ${registered.length} 个工具：${registered.map((d) => d.name).join(', ')}`)
for (const def of registered) {
  console.log(`  ${def.name}: parameters.type=${def.parameters?.type} required=${JSON.stringify(def.parameters?.required ?? null)}`)
}

/* ---------------- ② 本地兜底路径：必须产出标准 JSON Schema ---------------- */
const { parametersForDefineTool } = agent
const spec = {
  action: { type: 'string', required: true, description: 'move / attack / …' },
  ms: { type: 'integer', description: '按住多少毫秒' },
}
const localParams = parametersForDefineTool(spec, true)
if (localParams.type !== 'object') problems.push('本地兜底路径：parameters 没有顶层 type=object')
if (JSON.stringify(localParams.required) !== JSON.stringify(['action'])) problems.push(`本地兜底路径：required 应为 ["action"]，实际 ${JSON.stringify(localParams.required)}`)
if ('required' in localParams.properties.action) problems.push('本地兜底路径：属性里还留着 required（就是本次报错的写法）')
try { assertObjectJsonSchema(localParams) } catch (e) { problems.push(`本地兜底路径：${e.message}`) }

/* ---------------- ③ 宿主 defineTool 路径：必须是原样 spec ---------------- */
const hostParams = parametersForDefineTool(spec, false)
if (hostParams !== spec) problems.push('宿主路径：parameters 不该被改写（宿主 defineTool 自己做 spec→schema）')

/* ---------------- ④ 灵敏度自证：旧写法必须被判红 ---------------- */
let sensOk = false
try {
  assertObjectJsonSchema({
    type: 'object',
    properties: { action: { type: 'string', required: true, description: 'x' } },
    required: ['action'],
    additionalProperties: false,
  })
} catch (e) {
  sensOk = e instanceof JsonSchemaError && /required is not supported on type "string"/.test(e.message)
  if (!sensOk) problems.push(`灵敏度自证：报错文本不对 —— ${e.message}`)
}
if (!sensOk && !problems.some((p) => p.startsWith('灵敏度自证'))) problems.push('灵敏度自证：旧写法竟然过了校验器（校验器没接对）')

if (problems.length) {
  console.log('\n❌ 问题：')
  for (const p of problems) console.log('  -', p)
  process.exit(1)
}
console.log('\n✅ 6 个工具的 parameters / output.schema 过 DSH 的 JSON Schema 子集校验')
console.log('✅ 本地兜底 = 标准 JSON Schema；宿主 defineTool = 原样 spec；旧写法被正确判红')

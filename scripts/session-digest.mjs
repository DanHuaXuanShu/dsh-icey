// 只读：解压 DSH 会话日志（每条事件一个独立 zstd 帧），做结构统计与「人话」抽取。
// 用法：
//   node scripts/session-digest.mjs <会话目录|全部> [summary|types|prompts|last]
//     summary  结构统计（默认）
//     types    每种事件一条样例
//     prompts  全部用户消息（截断）
//     last     最后 N 条人类/助手文本
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from('28b52ffd', 'hex')
const target = process.argv[2]
const mode = process.argv[3] || 'summary'
const arg4 = Number(process.argv[4] || 0)
const ROOT = 'C:\\Users\\m1878\\.dsh\\sessions\\--D-dsh-ICEY~63D2~4EF6--'

function readEvents(file) {
  const b = fs.readFileSync(file)
  const offs = []
  let i = 0
  while ((i = b.indexOf(MAGIC, i)) !== -1) { offs.push(i); i++ }
  offs.push(b.length)
  const events = []
  let broken = 0
  for (let k = 0; k < offs.length - 1; k++) {
    try {
      const out = zlib.zstdDecompressSync(b.slice(offs[k], offs[k + 1])).toString('utf8')
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        events.push(JSON.parse(line))
      }
    } catch { broken++ }
  }
  return { events, bytes: b.length, frames: offs.length - 1, broken }
}

const findZstd = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const h = findZstd(p); if (h) return h }
    else if (e.name.endsWith('.zstd')) return p
  }
  return null
}

const stamp = (e) => Number(e.ts || e.at || e.time || e.createdAt || 0)

function textOf(e) {
  const c = e.content ?? e.text ?? e.message?.content ?? e.payload?.content ?? e.data?.content ?? ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('')
  return ''
}

function digest(sessionDir, { verbose = true } = {}) {
  const file = findZstd(sessionDir)
  if (!file) return null
  const { events, bytes, frames, broken } = readEvents(file)
  const meta = events.find((e) => e.type === 'session') || {}
  const hist = new Map()
  for (const e of events) {
    const k = `${e.type || '?'}${e.role ? ':' + e.role : ''}`
    hist.set(k, (hist.get(k) || 0) + 1)
  }
  const times = events.map(stamp).filter((t) => t > 0)
  const t0 = times.length ? Math.min(...times) : 0
  const t1 = times.length ? Math.max(...times) : 0
  const out = { id: meta.id || path.basename(sessionDir), origin: meta.origin, parent: meta.parentSession, preset: meta.agentPreset, depth: meta.delegationDepth, frames, broken, mb: +(bytes / 1048576).toFixed(1), events: events.length, t0, t1, hist, events_list: events }
  if (verbose) {
    console.log(`\n===== ${out.id}`)
    console.log(`  ${out.mb}MB · ${frames} 帧 · ${events.length} 事件${broken ? ` · ${broken} 帧解不开` : ''}`)
    console.log(`  origin=${out.origin || '-'} preset=${out.preset || '-'} 父=${out.parent || '-'} 深度=${out.depth ?? '-'}`)
    if (t0) console.log(`  ${new Date(t0).toLocaleString('zh-CN')} → ${new Date(t1).toLocaleString('zh-CN')}`)
    console.log('  事件：' + [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
  }
  return out
}

const dirs = target === '全部'
  ? fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(ROOT, e.name))
  : [target]

for (const dir of dirs) {
  const d = digest(dir)
  if (!d) continue
  const evs = d.events_list

  if (mode === 'types') {
    const seen = new Map()
    for (const e of evs) {
      const k = `${e.type || '?'}${e.role ? ':' + e.role : ''}`
      if (!seen.has(k)) seen.set(k, e)
    }
    for (const [k, e] of seen) {
      console.log(`\n--- ${k}  keys=${Object.keys(e).join(',')}`)
      console.log(JSON.stringify(e).slice(0, 600))
    }
  }

  // 真人发言：user/message 且 data.source.kind === 'user'（其余是工具结果/注入）
  if (mode === 'human' || mode === 'asst') {
    const rows = []
    for (const e of evs) {
      if (mode === 'human') {
        if (e.type !== 'user/message') continue
        const kind = e.data?.source?.kind || '?'
        const txt = (e.data?.content || []).map((p) => p?.text || '').join('')
        if (!txt.trim()) continue
        rows.push({ at: Number(e.time || 0), seq: e.seq, kind, txt })
      } else {
        if (e.type !== 'assistant/message') continue
        const txt = (e.data?.content || []).map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim()
        if (!txt) continue
        rows.push({ at: Number(e.time || 0), seq: e.seq, kind: e.data?.role || 'assistant', txt })
      }
    }
    for (const r of rows) {
      const tag = mode === 'human' && r.kind !== 'user' ? `[${r.kind}]` : ''
      if (mode === 'human' && r.kind !== 'user' && !process.env.ALL_KINDS) continue
      console.log(`\n#${r.seq} ${new Date(r.at).toLocaleString('zh-CN')} ${tag} ${r.txt.replace(/\s+/g, ' ').slice(0, Number(process.env.WIDTH || 400))}`)
    }
    console.log(`\n（${rows.length} 条${mode === 'human' ? '，只列 source.kind=user 的' : ''}）`)
  }

  if (mode === 'prompts' || mode === 'last') {
    const human = []
    for (const e of evs) {
      const t = textOf(e)
      if (!t || !t.trim()) continue
      const role = e.role || (e.type === 'user' ? 'user' : e.type === 'assistant' ? 'assistant' : null)
      if (!role) continue
      human.push({ role, t: t.replace(/\s+/g, ' ').trim(), at: stamp(e) })
    }
    const pick = mode === 'prompts' ? human.filter((h) => h.role === 'user') : human.slice(-(arg4 || 12))
    for (const h of pick) {
      console.log(`\n[${new Date(h.at || 0).toLocaleString('zh-CN')}] ${h.role}: ${h.t.slice(0, arg4 && mode === 'last' ? 1200 : 500)}`)
    }
    console.log(`\n（${pick.length} 条）`)
  }
}

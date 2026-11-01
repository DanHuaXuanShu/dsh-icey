/**
 * probe/_redcheck.mjs —— 证明新加的断言**真的会红**（一次性脚本，验完删）。
 *
 * 为什么专门写这个（2026-11-01 两次栽跟头）：
 *   ① 断言写错正则 → 明明在却被判红；反过来也能「明明坏了却是绿的」。
 *   ② 用 String.replace 做临时破坏/还原，目标串没匹配上时**原样返回、一声不吭**，
 *      「还原」根本没生效，坏代码被提交（e8d632d 就是这么来的）。
 * 所以这里：每处破坏先断言目标串**恰好出现一次**，再写；finally 里还原并**校验哈希**。
 *
 * ⚠️ 子进程输出走**文件重定向**而不是管道：受限沙箱里 `child_process` 用默认
 *    stdio:'pipe' 抓输出会 EPERM（第一版就是因此拿不到任何输出，误以为「0 条红」）。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const p = (rel) => join(root, rel)
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const tmpFile = join(tmpdir(), `icey-selfcheck-${process.pid}.txt`)

function runSelfcheck() {
  // 输出直接写文件，不经管道；**退出码非零是正常的**（有断言红就会非零），
  // 所以这里吞掉 execSync 的异常，照样读文件 —— 第一版就是因为这个误报「跑 selfcheck 出错」。
  try {
    execSync(`"${process.execPath}" selfcheck.mjs > "${tmpFile}" 2>&1`, { cwd: root, stdio: 'ignore' })
  } catch { /* 退出码非零 = 有红，正是要看的 */ }
  return readFileSync(tmpFile, 'utf8')
}

const cases = [
  {
    name: '把 describeStatus 里那行布局渲染删掉',
    file: 'agent.js',
    from: '    describeInputLang(st.inputLang),\n',
    to: '',
    expect: ['describeStatus 真的读了 st.inputLang', 'describeStatus 用统一的 describeInputLang'],
  },
  {
    name: '把 attach 的键名改回 inputlang',
    file: 'lib/game.mjs',
    from: 'health: this.health, inputLang,',
    to: 'health: this.health, inputlang,',
    expect: ['返回字段统一叫 inputLang', 'attach 返回值里带 inputLang'],
  },
  {
    name: '把归一函数改成照抄原始 ok（中文布局会被判成没问题）',
    file: 'lib/inputlang.mjs',
    from: '  const ok = english === true',
    to: '  const ok = raw.ok === true',
    expect: ['归一：中文布局虽是「读成功」也必须 ok:false'],
  },
  {
    name: 'agent.js 不再从 lib/inputlang.mjs 取那句话',
    file: 'agent.js',
    from: "import { describeInputLang } from './lib/inputlang.mjs'",
    to: "import { describeInputLang } from 'node:path'",
    expect: ['布局那句人话只由 lib/inputlang.mjs 提供'],
  },
]

const results = []
for (const c of cases) {
  const f = p(c.file)
  const before = readFileSync(f, 'utf8')
  const beforeHash = sha(before)
  const hits = before.split(c.from).length - 1
  if (hits !== 1) {
    // 这一条就是给「替换静默失败」准备的：目标串必须恰好一处，否则整轮不成立
    results.push({ name: c.name, ok: false, why: `目标串出现 ${hits} 次（要求恰好 1 次）` })
    continue
  }
  let red = []
  try {
    writeFileSync(f, before.replace(c.from, c.to), 'utf8')
    const out = runSelfcheck()
    red = out.split('\n').filter((l) => /^\s+FAIL /.test(l)).map((l) => l.replace(/^\s+FAIL\s+/, '').trim())
  } catch (e) {
    results.push({ name: c.name, ok: false, why: `跑 selfcheck 出错：${e?.message?.slice(0, 120)}` })
    writeFileSync(f, before, 'utf8')
    continue
  } finally {
    writeFileSync(f, before, 'utf8')
    if (sha(readFileSync(f, 'utf8')) !== beforeHash) throw new Error(`${c.file} 还原后哈希不符！`)
  }
  const missed = c.expect.filter((name) => !red.some((r) => r.startsWith(name)))
  results.push({
    name: c.name,
    ok: missed.length === 0,
    why: missed.length ? `这些断言没红：${missed.join(' / ')}；实际红了 ${red.length} 条` : `如预期变红（共红 ${red.length} 条）`,
  })
}

console.log('\n=== 变红验证 ===')
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.why}`)

const final = runSelfcheck()
const tail = final.trim().split('\n').filter((l) => /项通过/.test(l)).join(' ')
console.log(`\n=== 还原后自检 ===\n${tail}`)
if (existsSync(tmpFile)) rmSync(tmpFile)
const allGood = results.every((r) => r.ok) && /0 项失败/.test(tail)
console.log(allGood ? '\n✅ 四条断言都证明会红，且文件已完整还原' : '\n❌ 有没红的断言或还原失败')
process.exit(allGood ? 0 : 1)

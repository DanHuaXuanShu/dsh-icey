/**
 * probe/release-check.mjs —— 一条命令看清「发布到哪一步了」
 *
 * 只看公开信息（npm registry + GitHub API），不需要任何 token：
 *   ① 本地 package.json 版本
 *   ② npm registry 上的 latest 版本（是否已发布）
 *   ③ git 本地 tag / 远端 tag / 是否与版本号一致
 *   ④ GitHub Actions 最近一次「Publish to npm」的结论
 *
 * 用法：node probe/release-check.mjs
 * 退出码：0 = npm 已是本版且 CI 成功；1 = 还没发出去；2 = 有异常
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REPO = 'DanHuaXuanShu/dsh-icey'
const NPM = 'https://registry.npmjs.org'

const out = []
let problems = 0

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function jget(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-icey-release-check' }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) return { error: `HTTP ${r.status}` }
  return r.json()
}

/* ① 本地版本 */
const version = PKG.version
out.push(`本地版本        ${PKG.name}@${version}`)

/* ② npm 上有没有 */
let latest = ''
const reg = await jget(`${NPM}/${PKG.name}`)
if (reg.error) {
  out.push(`npm registry    ${reg.error}（网络或包名问题）`)
  problems++
} else {
  latest = reg['dist-tags']?.latest || ''
  const published = !!(reg.versions && reg.versions[version])
  out.push(`npm latest      ${latest || '(无)'}${published ? `  ✅ 已包含 ${version}` : `  ⚠️ 还没有 ${version}`}`)
  if (!published) problems++
}

/* ③ git tag */
const localTag = git(['tag', '-l', `v${version}`])
const headMatch = git(['rev-parse', '--short', 'HEAD'])
const tagCommit = localTag ? git(['rev-list', '-n', '1', `v${version}`]).slice(0, 7) : ''
const remoteTags = git(['ls-remote', '--tags', 'origin'])
const remoteHas = remoteTags.includes(`refs/tags/v${version}`)
out.push(`git tag         ${localTag ? `v${version} → ${tagCommit}` : '（本地没有）'}${remoteHas ? '  远端已有' : '  ⚠️ 远端没有'}`)
if (localTag && tagCommit !== headMatch) {
  out.push(`  ⚠️ tag 指向 ${tagCommit}，但 HEAD 是 ${headMatch}（tag 落后于最新提交）`)
}
if (!remoteHas) problems++

/* ④ CI */
const runs = await jget(`https://api.github.com/repos/${REPO}/actions/runs?per_page=5`)
if (runs.error) {
  out.push(`CI              ${runs.error}`)
} else {
  const mine = (runs.workflow_runs || []).find((r) => r.head_branch === `v${version}`)
  if (!mine) {
    out.push(`CI              ⚠️ 没找到 tag v${version} 的运行记录`)
    problems++
  } else {
    out.push(`CI              ${mine.status} / ${mine.conclusion || '-'}   ${mine.html_url}`)
    if (mine.conclusion !== 'success') problems++
  }
}

console.log('\n' + out.map((l) => '  ' + l).join('\n') + '\n')

if (problems === 0) {
  console.log(`✅ ${PKG.name}@${version} 已发布，CI 通过`)
  process.exit(0)
}

/* 有没发出去的，打印下一步该干什么 */
console.log('下一步：')
if (latest === version) {
  console.log('  npm 上已是本版，但 CI 或有异常，去上面链接看日志')
} else if (problems > 0) {
  console.log('  1) 确认 npmjs.com 上该包已配置 Trusted Publisher（GitHub Actions / 本仓库 / publish.yml）')
  console.log('  2) 配好后重跑 CI：GitHub → Actions → Publish to npm → Re-run all jobs')
  console.log(`  3) 或抬版本号再推一次 tag：npm version patch && git push --follow-tags`)
}
process.exit(1)

/**
 * probe/secret-scan.mjs —— 提交前/CI 里查「硬编码密钥」
 * ============================================================================
 * 起因：2026 年 GitHub 上硬编码密钥大面积泄漏（AI 服务的 key 同比 +81%），
 * 最常见的三个原因：
 *   1. 没写 .gitignore 就 `git add -A`，把 .env / config.json 一起推上去
 *   2. 图省事把 key 直接写进代码（`const key = "sk-..."`）
 *   3. 以为「删掉就没事了」—— 其实 git 历史里还在
 *
 * 这个脚本干两件事：
 *   - 扫**工作区**（默认）：所有文本文件按规则匹配
 *   - 扫**git 历史**（--history）：每个提交的每个快照都扫一遍
 *
 * 用法：
 *   node probe/secret-scan.mjs             # 扫工作区
 *   node probe/secret-scan.mjs --history   # 连历史一起扫
 *   node probe/secret-scan.mjs --all       # 含被 .gitignore 排除的目录（自己机器上查用）
 *
 * 退出码：0 = 干净；1 = 命中（CI 会因此失败）
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 别用 new URL('..').pathname：Windows 上会拿到百分号编码的乱码路径
//    （D:/dsh/ICEY%E6%8F%92%E4%BB%B6/），readdirSync 直接 ENOENT。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARGS = new Set(process.argv.slice(2))
const WITH_HISTORY = ARGS.has('--history') || ARGS.has('--all')
const WITH_IGNORED = ARGS.has('--all')

/** 这些目录不用扫：二进制/体积大/第三方代码/证据截图 */
const SKIP_DIRS = new Set([...['.git', 'node_modules'], ...(WITH_IGNORED ? [] : ['shots', 'workbuddy'])])
const SKIP_EXT = new Set(['.png', '.bmp', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.zip', '.tgz'])
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 规则表。宁可少报也不要误报 —— 误报多了大家就会习惯性忽略这个检查。
 * 每条都要求「足够长的随机串」，所以普通单词不会中。
 */
const RULES = [
  ['npm token', /npm_[A-Za-z0-9]{30,}/],
  ['OpenAI/DeepSeek 风格 key', /sk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/],
  ['GitHub 细粒度 token', /github_pat_[A-Za-z0-9_]{30,}/],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['明文赋值', /(api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i],
]

/**
 * 文件名本身就可疑（不管内容）。
 * ⚠️ 别写成「名字里含 secret 就算」—— 会把这个扫描脚本自己判成违规。
 *    只匹配真正的密钥/凭证文件名。
 */
const BAD_NAME = /(^|[\\/])\.env(\.|$)|\.(pem|pfx|p12|keystore)$|^id_(rsa|ed25519|ecdsa)$|^(credentials|secrets)\.(json|ya?ml)$/i

const hits = []
const suspiciousNames = []
let scanned = 0

function scanText(text, where) {
  for (const [label, re] of RULES) {
    const m = re.exec(text)
    if (m) {
      hits.push({ where, rule: label, sample: `${m[0].slice(0, 12)}…(${m[0].length} 字符)` })
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue }
    const rel = relative(ROOT, p).replace(/\\/g, '/')
    if (BAD_NAME.test(name)) suspiciousNames.push(rel)
    if (SKIP_EXT.has(extname(name).toLowerCase()) || st.size > MAX_BYTES) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    scanned++
    scanText(text, rel)
  }
}

console.log(`扫描工作区: ${ROOT}`)
walk(ROOT)
console.log(`  扫了 ${scanned} 个文本文件`)

if (suspiciousNames.length) {
  console.log('\n⚠️ 可疑文件名（很可能不该提交）：')
  for (const f of suspiciousNames) console.log(`  - ${f}`)
}

if (WITH_HISTORY) {
  let commits = []
  try {
    commits = execFileSync('git', ['rev-list', '--all'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    console.log('\n（不是 git 仓库或 git 不可用，跳过历史扫描）')
  }
  console.log(`\n扫描 git 历史: ${commits.length} 个提交`)
  for (const sha of commits) {
    let files = []
    try {
      files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch { continue }
    for (const f of files) {
      if (SKIP_EXT.has(extname(f).toLowerCase())) continue
      let blob
      try { blob = execFileSync('git', ['show', `${sha}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BYTES }) } catch { continue }
      scanText(blob, `${sha.slice(0, 7)}:${f}`)
    }
  }
}

if (hits.length) {
  console.log(`\n❌ 命中 ${hits.length} 处，**先别提交/推送**：`)
  for (const h of hits) console.log(`  - [${h.rule}] ${h.where}  ${h.sample}`)
  console.log('\n处理方式：')
  console.log('  1. 把密钥从文件里删掉，改用环境变量')
  console.log('  2. 把它加进 .gitignore')
  console.log('  3. **去服务商后台把这个 key 作废并重新生成** —— 已经泄露过的 key 光删文件没用')
  console.log('  4. 如果已经推送过：用 git filter-repo 清理历史，并立刻轮换密钥（历史里删不干净也无效）')
  process.exit(1)
}

if (suspiciousNames.length) {
  console.log('\n❌ 有可疑文件名，确认它们不该提交（或者已经写在 .gitignore 里）')
  process.exit(1)
}

console.log('\n✅ 没有发现硬编码密钥')

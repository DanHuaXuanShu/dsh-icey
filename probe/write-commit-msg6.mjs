import { writeFileSync } from 'node:fs'

const lines = [
  'fix(ci): 测试素材入库 —— 修 CI 上自检必然失败的问题',
  '',
  '现象：推 tag v0.3.0 后 GitHub Actions 在「自检」这一步失败，而本地 173 项全过。',
  '',
  '根因：',
  '.gitignore 里 `probe/**/*.png` 把 probe/fixtures/ 下的测试素材也排除了，',
  '所以仓库里根本没有 arrow-strip.png —— CI 检出代码后自检读文件直接抛错。',
  '（本地有是因为文件在磁盘上，只是没被 git 跟踪。这类「本地能过、CI 必挂」很难发现。）',
  '',
  '修复：',
  '1) .gitignore 加例外 `!probe/fixtures/*.png`，把两份真实画面切片纳入版本管理',
  '   （重新裁成 1606x100，313KB + 226KB）',
  '2) selfcheck 里那段素材回归：文件缺失时**明确跳过并打印一行提示**，',
  '   不再直接抛错 —— 免得把「素材没带」误判成「检测器坏了」',
  '   已实测：素材缺失 → 169 项通过 + 跳过提示；恢复后 → 173 项',
  '',
  '顺便：fix .gitignore 里被 PowerShell Set-Content 写成乱码的中文注释（用 node 重写）。',
]

writeFileSync('.git/CMSG.txt', lines.join('\n'), 'utf8')
console.log('ok')

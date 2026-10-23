import { readFileSync, writeFileSync } from 'node:fs'

const file = '.gitignore'
let text = readFileSync(file, 'utf8')

// 去掉之前写坏的那行注释（乱码），换成正常中文
text = text.replace(
  /^# .*[\uFFFD].*fixtures.*$/m,
  '',
)
// 也顺手去掉任何包含乱码字符的注释行
text = text
  .split('\n')
  .filter((line) => !(line.startsWith('#') && line.includes('\uFFFD')))
  .join('\n')

const marker = '!probe/fixtures/*.png'
if (!text.includes(marker)) {
  text = text.trimEnd() + '\n' + marker + '\n'
}
// 在 marker 前补一行正常注释
if (!text.includes('# 测试素材例外')) {
  text = text.replace(marker, '# 测试素材例外：自检要用的真实画面切片（很小，必须进仓库，否则 CI 上没有）\n' + marker)
}

text = text.replace(/\n{3,}/g, '\n\n')
writeFileSync(file, text, 'utf8')
console.log('--- .gitignore 末尾 ---')
console.log(text.trimEnd().split('\n').slice(-5).join('\n'))

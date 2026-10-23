/**
 * probe/extract-moves.mjs —— 从游戏程序集里抽「招式/动作」相关名字
 *
 * 目的：不靠攻略猜，直接从 Assembly-CSharp.dll 里把动作名、连段名、键位名抽出来，
 * 作为规则卡「招式表」的依据。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const DLL = 'D:/SteamLibrary/steamapps/common/ICEY/ICEY_Data/Managed/Assembly-CSharp.dll'
const buf = readFileSync(DLL)

/** 抽长度 ≥4 的可打印 ASCII 串（.NET 用 UTF-16 存字符串，两种都抽） */
function asciiStrings(b) {
  const out = new Set()
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c >= 32 && c < 127) cur += String.fromCharCode(c)
    else { if (cur.length >= 4) out.add(cur); cur = '' }
  }
  if (cur.length >= 4) out.add(cur)
  return out
}

function utf16Strings(b) {
  const out = new Set()
  let cur = ''
  for (let i = 0; i + 1 < b.length; i += 2) {
    const lo = b[i], hi = b[i + 1]
    if (hi === 0 && lo >= 32 && lo < 127) cur += String.fromCharCode(lo)
    else { if (cur.length >= 4) out.add(cur); cur = '' }
  }
  if (cur.length >= 4) out.add(cur)
  return out
}

const ascii = asciiStrings(buf)
const utf16 = utf16Strings(buf)
console.log(`从 DLL 抽到：ASCII 串 ${ascii.size} 个，UTF-16 串 ${utf16.size} 个`)

const KEYWORDS = /(Attack|Combo|Skill|Slash|Dash|Storm|Shade|Chase|Execute|Heavy|Blade|Air|Counter|Parry|Finisher|Special|Flash|Jump|Hit|Beat)/i
const hits = [...new Set([...ascii, ...utf16])]
  .filter((s) => KEYWORDS.test(s) && s.length <= 48)
  .sort()

console.log(`\n=== 动作/招式相关（${hits.length}）===`)
for (const h of hits.slice(0, 120)) console.log('  ' + h)

// 单独把「看起来像输入动作名」的挑出来（Rewired 的 action 名通常是驼峰）
const actions = hits.filter((s) => /^[A-Z][A-Za-z]*$/.test(s))
console.log(`\n=== 可能是键位动作名（${actions.length}）===`)
console.log('  ' + actions.join(', '))

writeFileSync('shots/moves-extracted.txt', [
  '# 从 Assembly-CSharp.dll 抽出的动作相关串',
  ...hits,
].join('\n'), 'utf8')
console.log('\n已写入 shots/moves-extracted.txt')

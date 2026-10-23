import { writeFileSync } from 'node:fs'

const lines = [
  'feat: 按招式表重建连招 + 战斗权重改为「多打少动」',
  '',
  '用户要求：看一下连招，然后提高战斗时的攻击欲望、减少位移权重。',
  '',
  '连招表的问题与修正：',
  '- 原来 `jjjji` 重复出现两次（无效条目）',
  '- 缺带方向的连招（凝滞 ↓+J、激发 ↑+J 都是招式表里的控制/挑空起手）',
  '- control.mjs 的 combo 现在支持 w/s（上下）+ `_`（该键长按）',
  '',
  '新连招表（全部对应招式表条目）：',
  '  jjjjj   扰动（地）五连',
  '  jjjji   颤振 收尾重击（击飞小型敌人）',
  '  jjji    迭影（地）穿刺',
  '  jjiii   磁阱 吸附后范围追打',
  '  ji      震荡 上挑',
  '  iii     荡涤 破盾三连',
  '  sj      凝滞 ↓+J 定身',
  '  wj      激发 ↑+J 挑空',
  '  iiij    破盾后接重击收尾',
  '',
  '战斗权重（27 总权重）：',
  '  combo 10 (37%) / heavy 6 (22%) / attack 5 (18%) → 攻击类合计 77.8%',
  '  chase 1 / dash 1 → 位移类合计 7.4%（原来 22%）',
  '  execute 2, storm 1, shade 1',
  '  （move/jump 已从战斗权重移除 —— 打架时不该走路）',
  '',
  'selfcheck 157 项（+3：攻击占比≥70%、位移占比≤10%、连招合法键含 w/s）',
]

writeFileSync('.git/CMSG.txt', lines.join('\n'), 'utf8')
console.log('ok')

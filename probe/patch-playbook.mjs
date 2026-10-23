import { readFileSync, writeFileSync } from 'node:fs'

const file = 'lib/playbook.mjs'
let p = readFileSync(file, 'utf8')

if (p.includes('executeRule')) {
  console.log('已经插入过，跳过')
  process.exit(0)
}

const anchor = '  /** 怎么判断「真的在前进」—— 这是自动连玩最需要的东西 */'
if (!p.includes(anchor)) {
  console.log('锚点没找到：', anchor)
  process.exit(1)
}

const block = [
  '  /**',
  '   * **处决**（用户 2026-10-23 说明）：',
  '   *   怪物身上冒黄圈、头顶出现 L 时按 L 处决 —— 回血、回护盾、掉能量结晶。',
  '   *   处决完地上有结晶，可长按 J 吸收并释放超载（招式表里「超载」就是 J 长按）。',
  '   *   处决是全游戏性价比最高的动作之一，优先级高于继续输出。',
  '   */',
  '  executeRule: [',
  "    '看到黄圈 + 头顶 L ⇒ 立刻按 L 处决（回血回盾掉结晶）',",
  "    '处决完 0.7~3 秒内长按 J（1.2 秒）吸收能量结晶并释放超载',",
  "    '处决优先级高于连段和重击：多打两下的收益远不如一次处决',",
  '  ],',
  '',
].join('\n')

p = p.replace(anchor, block + anchor)

const renderAnchor = '  if (p.guideArrow) {'
if (p.includes(renderAnchor)) {
  const render = [
    '  if (p.executeRule) {',
    "    lines.push('## 处决（收益最高的动作）')",
    '    for (const s of p.executeRule) lines.push(`- ${s}`)',
    "    lines.push('')",
    '  }',
    '',
  ].join('\n')
  p = p.replace(renderAnchor, render + renderAnchor)
  console.log('渲染块已插入')
} else {
  console.log('没找到渲染锚点 guideArrow，只插入了数据')
}

writeFileSync(file, p, 'utf8')
console.log('完成')

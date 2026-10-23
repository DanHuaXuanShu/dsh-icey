import { readFileSync, writeFileSync } from 'node:fs'

const file = 'lib/playbook.mjs'
let p = readFileSync(file, 'utf8')

if (!p.includes('menuRule')) {
  const anchor = '  /** 怎么判断「真的在前进」—— 这是自动连玩最需要的东西 */'
  if (!p.includes(anchor)) {
    console.log('锚点没找到')
    process.exit(1)
  }
  const block = [
    '  /**',
    '   * **停在菜单里**（2026-10-23 踩到的真 bug）：',
    '   *   强化页面右侧有一块**招式演示动画**一直在动，被误当成"游戏还在跑"，',
    '   *   于是自动连玩继续按键 —— 而强化页里的 Enter 是「升级」，会直接花掉 \$。',
    '   *',
    '   * 判据（用 6 张菜单截图 + 7 张实机帧校准）：',
    '   *   左侧 18%~42% 区域出现 **≥9 行文字**，或整屏**压暗超过 90%**。',
    '   *   菜单帧 listBands 13~18 / 实机帧 1~8，分离度够用。',
    '   *',
    '   * 处理：判定为菜单时**只按 Esc**（游戏里只是开关暂停菜单，代价极低），',
    '   *       并且**在这一态下彻底禁用 Enter**；连续按 3 次 Esc 还退不出就停下交回。',
    '   */',
    '  menuRule: [',
    "    '画面像菜单（左侧多行文字 / 整体压暗）⇒ 只按 Esc，绝不按 Enter',",
    "    '强化页里的 Enter 是「升级」，会花钱；暂停菜单里的 Enter 可能是「退出」，会丢档',",
    "    '按 3 次 Esc 仍未退出 ⇒ 停下并说明，交回人工确认',",
    '  ],',
    '',
  ].join('\n')
  p = p.replace(anchor, block + anchor)

  const renderAnchor = '  if (p.executeRule) {'
  if (p.includes(renderAnchor)) {
    const render = [
      '  if (p.menuRule) {',
      "    lines.push('## 停在菜单里怎么办')",
      '    for (const s of p.menuRule) lines.push(`- ${s}`)',
      "    lines.push('')",
      '  }',
      '',
    ].join('\n')
    p = p.replace(renderAnchor, render + renderAnchor)
  }
  writeFileSync(file, p, 'utf8')
  console.log('已插入 menuRule')
} else {
  console.log('已存在，跳过')
}

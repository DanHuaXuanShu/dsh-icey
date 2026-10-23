import { writeFileSync } from 'node:fs'

const lines = [
  'fix: 停在强化界面时只按 Esc、绝不按 Enter（修复「把招式演示当成实机画面」）',
  '',
  '用户报的 bug：DSH 停在强化页面出不来，因为强化页右侧的**招式演示动画**一直在动，',
  '被当成"游戏还在跑"，于是自动连玩继续按键 —— 而强化页里的 Enter 是「升级」，会直接花钱。',
  '',
  '根因：',
  '- 原来的「在不在游戏里」判据是 hudBright（左上血条亮不亮）。菜单里血条照样画着，所以判据认为在游戏里',
  '- 相邻帧 motion 因为演示动画而不为 0，卡住判定也不触发',
  '- 结果：阶梯一路按下去，按到 interact 那步 = Enter = 升级',
  '',
  '修复：',
  '1) analyzeEnvironment 增加菜单结构指标：',
  '   darkRatio（整屏暗像素占比）、listBands（左侧 18%~42% 区域的文字行数）、longLines（长横线数）',
  '2) 新判据（6 张菜单截图 + 7 张实机帧校准）：listBands >= 9 或 darkRatio > 0.90',
  '   实测菜单帧 listBands 13~18 / 实机帧 1~8，分离度够用',
  '3) 策略：判定菜单后 → **只按 Esc**（游戏里只是开关暂停菜单，代价极低），节流 1.4 秒',
  '   并且在这一态下**彻底禁用 Enter**（连脱困阶梯的 interact 步也会改按 Esc）',
  '4) play()：菜单里按满 3 次 Esc 仍退不出 ⇒ 停下并如实说明「请人工确认界面状态」',
  '',
  '验证（用真实菜单截图跑策略 12 秒）：',
  '  动作序列 pause,wait,wait,pause,wait,wait,... → 一次 interact 都没有',
  '  selfcheck 164 项（+7：菜单识别、Esc 节流、计数、20 秒内零 Enter、正常画面不误判）',
  '  5 个探针全过',
  '',
  '顺带：修 selfcheck.mjs 被 PowerShell 管道搞出的编码损坏（用 git archive 取回 HEAD 版本）',
]

writeFileSync('.git/CMSG.txt', lines.join('\n'), 'utf8')
console.log('ok')

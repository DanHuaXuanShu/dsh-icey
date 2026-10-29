// 一次性探针：提示框亮着、人卡住不动时，到底会按几次 Enter？
// 2026-10-29 用户实测：弥城死镇出生点紧挨强化台，第 1 次 Enter 开界面、第 2 次就是花钱。
import { createPolicy } from '../lib/autoplay.mjs'

for (const gap of [400, 800, 1200]) {
  const p = createPolicy('advance')
  const seen = []
  for (let i = 0; i < 40; i++) {
    const d = p.decide({
      motion: 0.002, hudKick: 0, hudBright: 0.08,
      hp: 0.6, shield: 0.09, combo: 0,
      progress: 0.0, promptBright: 0.003,
    }, { now: i * gap })
    seen.push(d.action)
  }
  const n = seen.filter((a) => a === 'interact').length
  console.log(`gap=${gap}ms  interact=${n}  actions=${seen.join(',')}`)
}

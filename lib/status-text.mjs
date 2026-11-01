/**
 * lib/status-text.mjs —— 把 status 对象压成给模型看的那段人话
 * ============================================================================
 * 🔴 为什么从 agent.js 搬到这里（2026-11-01，检查会话提的第二轮意见）：
 *
 *   这段文字以前是 agent.js 里的私有函数，**只能靠 grep 源码来验**。
 *   于是「它到底有没有把键盘布局那一行拼进去」只能写成一条正则断言 ——
 *   而正则断言有两种坏法：写错了会误报红（真出过），写对了也只是在看「代码长得像」，
 *   并没有真的跑一遍。搬出来成纯函数之后，自检可以直接喂假 status 进去看输出，
 *   喂什么都能验，也不怕以后有人重排缩进把它弄假红。
 *
 *   同一天还用这个思路删掉了 probe/_redcheck.mjs（那套脚本靠临时改源码、跑自检、
 *   再还原，来证明断言会红）：能变成「真跑函数」的部分全搬进自检，
 *   剩下按名字/按 import 那种文本型断言才继续留在源码检查里。
 *
 * 只做纯文字：不读文件、不碰窗口、不 await。
 * ============================================================================
 */
import { describeCombat } from './autoplay.mjs'
import { describeInputLang } from './inputlang.mjs'

/** 动作明细：只报「动作 N 次」等于复不了盘（不知道打的是连段还是普攻、有没有闪） */
const fmtActions = (a) => Object.entries(a || {})
  .filter(([, v]) => v > 0)
  .sort((x, y) => y[1] - x[1])
  .map(([k, v]) => `${k}×${v}`)
  .join(' ')

/**
 * 把 status 压成一句人话，别让模型自己拼。
 *
 * ⚠️ 这里的每一行都是模型能看到的**唯一**渠道：status() 返回的对象模型根本看不见。
 *    2026-11-01 的教训 —— `status().inputLang` 明明有值，这里没读，
 *    结果「数据到位」和「模型看到」之间断了一整层，而自检全绿。
 */
export function describeStatus(st) {
  if (!st || !st.running) {
    return `没接上游戏。${st?.health?.reason || ''}\n下一步：icey_start（launchMode=attach 接上已经开着的窗口；如果游戏没开，用 steam 或 direct 让插件启动）。`
  }
  const bits = [
    `窗口 ${st.rect ? `${st.rect.width}x${st.rect.height}` : '?'}`,
    `pid ${st.pid}`,
    `已连 ${Math.round((st.uptimeMs || 0) / 1000)} 秒`,
    st.health?.foreground ? '在前台' : '不在前台',
  ]
  if (st.minimized) bits.push('已最小化')
  if (st.backend && !st.backend.koffiOk) bits.push('⚠️ koffi 不可用 ⇒ 只能看不能动')
  const canAct = st.health?.playable
  const lines = [
    `接上了：${bits.join('，')}。`,
    canAct
      ? '可以操作（按键会先把游戏抢到前台，会打断你正在做的事）。'
      : `现在不能操作：${st.health?.reason || '原因未知'}`,
    // 「能操作」只看窗口在前台、抓不抓得到画面，跟按键进不进得去游戏是两件事 ——
    // 所以这一行必须单独出现，别并进上一行。
    describeInputLang(st.inputLang),
    st.queue ? `动作队列：${st.queue.depth} 个在等，已完成 ${st.queue.done}。` : '',
  ].filter(Boolean)
  // 后台战斗的运行态 + 上一场的结局（2026-10-27 加）。
  // 后台模式下模型拿不到同步返回值，停手原因只能从这里读 —— 不给它，模型就没法复盘。
  const bg = st.background
  if (bg?.running) {
    lines.push(`⚔️ 后台战斗进行中：已 ${Math.round((bg.elapsedMs || 0) / 1000)} 秒 / 上限 ${bg.maxSeconds} 秒，`
      + `focus=${bg.order.focus} style=${bg.order.style}${bg.abortRequested ? '（已请求停手，下一步停）' : ''}。`)
    if (bg.orderError) lines.push(`  ⚠️ 微调参数被拒：${bg.orderError}`)
    const acts = fmtActions(bg.actions)
    if (acts) lines.push(`  动作：${acts}`)
    if (bg.lastEvents?.length) lines.push(`  最近：${bg.lastEvents.join(' / ')}`)
  } else if (bg?.last) {
    const l = bg.last
    lines.push(`上一场后台战斗：${l.seconds} 秒（${l.preset || '?'}），停因「${l.stopped || '未知'}」。`)
    const acts = fmtActions(l.actions)
    if (acts) lines.push(`  动作：${acts}`)
    // 2026-10-29：连击区峰值/上涨次数 —— 后台模式打完只有动作计数的话，
    // 分不清「打中了」和「空挥了一整场」。这一行就是那个分界。
    if (l.combat) lines.push(`  ${describeCombat(l.combat)}`)
    if (l.order && (l.order.focus !== 'auto' || l.order.style !== 'auto')) {
      lines.push(`  当时微调：focus=${l.order.focus} style=${l.order.style}`)
    }
  }
  return lines.join('\n')
}

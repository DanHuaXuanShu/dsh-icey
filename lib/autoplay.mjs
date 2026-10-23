/**
 * lib/autoplay.mjs —— 「自己玩一段」的策略引擎
 * ============================================================================
 * 这个模块**不认识 DSH，也不认识按键**：只做两件事，都是纯函数，能离线单测：
 *
 *   analyze(当前帧, 上一帧)    → 画面指标（变化量、静止比、HUD 有没有在跳）
 *   createPolicy(preset).decide(指标, 历史) → 下一个动作 {action, dir, ms, why}
 *
 * 🔴 先说清它**不是什么**：
 *   它不是视觉大模型，看不懂「前面有只怪」。它是**侧滚轴游戏的常识性自动驾驶**：
 *   往右走、按节奏挥刀、卡住就按确认键。这在 ICEY 这种横版游戏里能自己跑很长一段，
 *   但遇到真正的解谜/分支选择，它会卡住 —— 所以带「卡住就停」和「按时截图汇报」。
 *
 * 为什么信号只用这两个（可靠、便宜、不误判）：
 *   motion   —— 两帧差异比例。ICEY 待机也有动画，所以「几乎不动」= 被对话框/菜单/
 *               过场挡住，或者到了场景尽头。这时候按 Enter 通常就过去了。
 *   hudKick  —— 左上 HUD（血条那一带）的变化量。战斗中血条/连击数一直在变，
 *               所以这个值高 ≈ 在打架，可以加大攻击频率。
 * ============================================================================
 */

/** 画面里「左上一带 HUD」用的相对坐标（按宽度/高度比例，不写死像素） */
const HUD_BOX = { x0: 0.03, y0: 0.08, x1: 0.32, y1: 0.20 }
/**
 * 「互动提示框」区域：角色右边、屏幕中下部那一条。
 * ICEY 里能互动的东西（门/机关/NPC）靠近时会浮出白字提示（「按 J: 开启强化」那种），
 * 不能互动的东西（锁住的门、纯装饰）**没有提示框** —— 这就是分辨它们的关键信号。
 */
const PROMPT_BOX = { x0: 0.55, y0: 0.50, x1: 0.90, y1: 0.75 }

/** 一帧的像素级指标（纯函数） */
export function analyzeFrame(rgba, width, height, prev = null) {
  const n = width * height * 4
  if (!rgba || rgba.length < n) return { ok: false, reason: '帧数据不完整' }

  // HUD 区域的亮度均值 + 亮像素占比（血条/数字一变，这两个值就跳）
  const hx0 = Math.floor(width * HUD_BOX.x0)
  const hx1 = Math.floor(width * HUD_BOX.x1)
  const hy0 = Math.floor(height * HUD_BOX.y0)
  const hy1 = Math.floor(height * HUD_BOX.y1)
  let hudSum = 0
  let hudCount = 0
  let bright = 0
  // 采样步长：HUD 区域不用逐像素，4 步一点已经够稳
  for (let y = hy0; y < hy1; y += 2) {
    const rowBase = y * width * 4
    for (let x = hx0; x < hx1; x += 4) {
      const i = rowBase + x * 4
      const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      hudSum += lum
      // 血条是亮青色、数字是亮黄，都远高于 150；标题界面的夜空/雪地在该区域是暗的
      if (lum > 150) bright++
      hudCount++
    }
  }
  const hud = hudCount ? hudSum / hudCount : 0
  const hudBright = hudCount ? bright / hudCount : 0

  // 互动提示框：那一带里**白色文字**占比。没有提示框时那里是场景/地面，几乎不亮。
  const px0 = Math.floor(width * PROMPT_BOX.x0), px1 = Math.floor(width * PROMPT_BOX.x1)
  const py0 = Math.floor(height * PROMPT_BOX.y0), py1 = Math.floor(height * PROMPT_BOX.y1)
  let pBright = 0
  let pCount = 0
  for (let y = py0; y < py1; y += 2) {
    const rowBase = y * width * 4
    for (let x = px0; x < px1; x += 2) {
      const i = rowBase + x * 4
      const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
      // 提示文字是很纯的白（240+），比场景里最亮的地面还亮
      if (lum > 235) pBright++
      pCount++
    }
  }
  const promptBright = pCount ? pBright / pCount : 0

  if (!prev || prev.width !== width || prev.height !== height) {
    return { ok: true, width, height, hud, hudBright, promptBright, motion: null, hudKick: null }
  }

  // 整体变化比例（抽样，够用且快）
  const stride = Math.max(4, Math.floor(n / 24000 / 4) * 4)
  let changed = 0
  let total = 0
  for (let i = 0; i < n; i += stride) {
    total++
    if (Math.abs(rgba[i] - prev.rgba[i]) > 12 ||
        Math.abs(rgba[i + 1] - prev.rgba[i + 1]) > 12 ||
        Math.abs(rgba[i + 2] - prev.rgba[i + 2]) > 12) changed++
  }
  const motion = total ? changed / total : 0
  const hudKick = Math.abs(hud - (prev.hud ?? hud)) / 255

  return { ok: true, width, height, hud, hudBright, promptBright, motion, hudKick }
}

/* ============================ 预设 ============================ */

/**
 * 三个预设。都只是「参数不同的同一个状态机」，不是三套代码。
 * moveMs / attackChance 之类可以调，单位都是毫秒。
 */
export const PRESETS = {
  /** 默认：往右推进，节奏性挥刀，卡住按确认 */
  advance: {
    desc: '往右推进：走一段、挥一刀，卡住就按确认键',
    moveMs: 700,
    attackEvery: 2,      // 每 2 个循环攻击一次
    heavyEvery: 9,       // 每 9 个循环来一次重击
    jumpEvery: 0,        // 不主动跳
    dashWhenFight: true,
  },
  /** 打架：不走路，贴脸连打 */
  fight: {
    desc: '近身连打：重击和普攻交替，偶尔冲刺',
    moveMs: 0,
    attackEvery: 1,
    heavyEvery: 2,
    jumpEvery: 0,
    dashWhenFight: true,
  },
  /** 探索：走得更久，偶尔跳，少打架 */
  explore: {
    desc: '探索：长时间往右走，遇到障碍就跳',
    moveMs: 1100,
    attackEvery: 4,
    heavyEvery: 0,
    jumpEvery: 3,
    dashWhenFight: false,
  },
}

/* ============================ 策略状态机 ============================ */

/** 判定「几乎不动」的阈值：低于它就认为被挡住了 */
export const STILL_MOTION = 0.004
/** 判定「在打架」的阈值：HUD 变化超过它就算战斗 */
export const FIGHT_HUDKICK = 0.02
/**
 * 判定「已经进游戏」的阈值：左上 HUD 区域里亮像素（血条/数字）的占比。
 *
 * 🔴 为什么需要它（2026-10-23 真机踩到）：
 *   标题界面有**飘雪动画**，motion 一直在 1.5–2%，远高于 STILL_MOTION ——
 *   于是策略以为"画面在动"，一直走路挥刀，**从来不去按 Enter**，永远进不了游戏。
 *   实测：游戏内该区域亮像素 ≈ 8.4%，标题界面 ≈ 0%。差距足够大。
 */
export const PRESENCE_BRIGHT = 0.003
/**
 * 「原地踏步」阈值：2.5 秒内画面变化低于它 ⇒ 没有净进展（被门/墙挡住）。
 * 实测：正常走路 2.5 秒能换掉半屏（>50%）；卡在门前只有待机动画（~1.5%）。
 */
export const PROGRESS_MIN = 0.05
/** 卡住时的脱困动作顺序（循环使用）：退一步 → 确认 → 跳 → 重击 */
// 脱困顺序：退一步 → **Enter（互动/确认）** → 跳 → 重击
//
// 🔴 键位（用户纠正过两次，最终确认）：
//    ICEY 里**所有互动都是 Enter**——通用互动、对话确认、强化台，全都是它。
//    PlayerPrefs 里这个键就叫 `Search`（vk 13）。**J 只是普通攻击**。
//    （我一开始把提示框里那个 Enter 键位小图标看成了字母 J，误以为强化台用 J，
//      于是把 J 塞进阶梯、还写进了文档 —— 已全部改正。）
export const UNSTUCK_LADDER = ['back', 'interact', 'jump', 'heavy']
/**
 * 一次连玩里最多盲按几次确认键（Enter）。
 *
 * 🔴 为什么必须有上限（2026-10-23 真机事故）：ICEY 的暂停菜单里「退出」也是用确认键选的。
 *    我们的策略在卡住时会按 Enter；如果那时菜单正好开着、光标又在「退出」上，
 *    这一下就把游戏**退掉了**（实测发生过一次，游戏进程消失）。
 *    所以：确认键要限量，其余脱困手段优先。
 */
export const MAX_INTERACTS = 3
/**
 * 「还没进游戏」时最多按几次确认键（标题 → 主菜单 → 进入游戏，需要 2~3 次）。
 *
 * ⚠️ 这一路和「在游戏里卡住」要分开算：进游戏要经过标题、菜单、加载黑屏，
 * 期间画面本来就没 HUD、也没进展 —— 如果把它算进「卡住」，策略会在加载时
 * 提前判定「这条路走不通」而放弃（实测：6 秒就收手了）。
 */
export const MAX_BOOT_INTERACTS = 6

/**
 * 造一个策略实例。`decide()` 是纯的：同样的 (指标, 历史) 一定给同样的动作，
 * 所以 selfcheck 能穷举验证，不需要开游戏。
 *
 * @param {'advance'|'fight'|'explore'} preset
 * @param {{moveDir?: string}} [opts]
 */
export function createPolicy(preset = 'advance', opts = {}) {
  // 未知预设回落到 advance —— 并且**回报回落后的名字**（不然日志/摘要会显示一个不存在的预设）
  const resolved = PRESETS[preset] ? preset : 'advance'
  const p = PRESETS[resolved]
  let dir = opts.moveDir || 'right'
  let cycle = 0
  let stillStreak = 0
  let lastInteractAt = -Infinity
  let interactCount = 0
  let bootInteracts = 0
  let fighting = false

  return {
    preset: resolved,
    desc: p.desc,
    get cycle() { return cycle },
    get stillStreak() { return stillStreak },
    get fighting() { return fighting },
    get dir() { return dir },
    get interactCount() { return interactCount },

    /**
     * @param {{motion:number|null, hudKick:number|null}} m 画面指标
     * @param {{now:number}} [clock] 时间（毫秒，外部传入便于测试）
     * @returns {{action:string, dir?:string, ms?:number, why:string}}
     */
    decide(m, clock = { now: 0 }) {
      const motion = m.motion ?? 1
      const hudKick = m.hudKick ?? 0
      const bright = m.hudBright ?? 1
      fighting = hudKick >= FIGHT_HUDKICK
      cycle++

      // ⓪ 没检测到 HUD ⇒ 还没进游戏（标题/加载/过场）。
      //    这时候走路挥刀全是空按键，只能靠按确认键推进。
      //    有节流：两次之间至少 1.2 秒，别把确认键连点成一串。
      if (bright < PRESENCE_BRIGHT) {
        // 标题/菜单/加载：这**不是**「被挡住」，别计入 stuck（否则加载几秒就被判死路）
        stillStreak = 0
        if (clock.now - lastInteractAt > 1600 && bootInteracts < MAX_BOOT_INTERACTS) {
          lastInteractAt = clock.now
          bootInteracts++
          return {
            action: 'interact', ms: 120,
            why: `没检测到 HUD（亮像素 ${(bright * 100).toFixed(2)}%）→ 还在标题/加载，按确认键推进（${bootInteracts}/${MAX_BOOT_INTERACTS}）`,
          }
        }
        return { action: 'wait', ms: 400, why: '等界面加载出来（不空按键盘）' }
      }
      // 进游戏了：启动阶段的计数归零
      bootInteracts = 0

      // ① 原地踏步 ⇒ 被门/墙/解谜挡住。判据用「2.5 秒净进展」而不是相邻帧，
      //    否则待机动画（1.5%）会让人以为一直在往前走。
      const stuck = (m.progress !== null && m.progress !== undefined && m.progress < PROGRESS_MIN)
        || motion < STILL_MOTION
      if (stuck) {
        stillStreak++
        const pct = (m.progress === null || m.progress === undefined) ? null : m.progress
        const whyPrefix = pct === null
          ? `画面几乎不动（${(motion * 100).toFixed(2)}%）`
          : `2.5 秒净进展只有 ${(pct * 100).toFixed(1)}%（原地踏步）`
        // 一轮阶梯走完 ⇒ 判定这条路走不通，掉头换边探索。
        // ⚠️ 这段必须放在阶梯**之前**：之前放在最后，而停止阈值又等于阶梯长度，
        //    结果掉头永远执行不到（真机实测：卡在门上 11 秒就直接放弃了，没掉头）。
        // 一轮阶梯（4 步）+ 第 5 格「掉头」组成一个循环。
        // 用 length+1 取模，否则 stillStreak 是 4 的倍数时会被掉头抢掉，重击永远轮不到。
        const slot = (stillStreak - 1) % (UNSTUCK_LADDER.length + 1)
        if (slot === UNSTUCK_LADDER.length) {
          dir = dir === 'right' ? 'left' : 'right'
          return {
            action: 'move', dir, ms: 1600,
            why: `${whyPrefix} → 一轮交互都试过了（Enter/跳/重击），判断这条路走不通，掉头往${dir === 'left' ? '左' : '右'}走`,
          }
        }
        // 脱困阶梯：卡住时挨个试不同动作，别一直撞同一面墙。
        // 顺序：退一步 → **Enter（ICEY 唯一的互动键）** → 跳 → 重击
        const ladder = UNSTUCK_LADDER[slot]
        if (ladder === 'interact' && clock.now - lastInteractAt < 1200) {
          // 刚按过确认，别连点
          return { action: 'wait', ms: 200, why: `${whyPrefix} → 先等确认键的结果` }
        }
        if (ladder === 'interact') {
          // 确认键限量：盲按 Enter 有可能在菜单里选中「退出」把游戏退掉（真出过事）
          if (interactCount >= MAX_INTERACTS) {
            return { action: 'jump', ms: 140, why: `${whyPrefix} → 确认键已按满 ${MAX_INTERACTS} 次，改用跳` }
          }
          lastInteractAt = clock.now
          interactCount++
        }
        if (ladder === 'back') {
          return { action: 'move', dir: dir === 'right' ? 'left' : 'right', ms: 260, why: `${whyPrefix} → 反向挪一步` }
        }
        if (ladder === 'jump') return { action: 'jump', ms: 140, why: `${whyPrefix} → 跳一下试试` }
        if (ladder === 'j') return { action: 'attack', ms: 140, why: `${whyPrefix} → 按 J 试试（ICEY 的互动键就是 J）` }
        if (ladder === 'heavy') return { action: 'heavy', ms: 160, why: `${whyPrefix} → 用重击打一下（也许有个机关）` }

        return { action: 'interact', ms: 130, why: `${whyPrefix} → 按确认键试试` }
      }
      // 有进展时**衰减**而不是清零：
      // 原地踏步往往是「撞一下 → 相机抖一下 → 又不动」的锯齿，严格清零会让
      // 脱困阶梯永远走不到「掉头」那一步（真机实测：40 秒里只按了 4 次确认键）。
      stillStreak = Math.max(0, stillStreak - 1)

      // ② 在打架：加大输出
      if (fighting) {
        if (p.heavyEvery && cycle % p.heavyEvery === 0) return { action: 'heavy', ms: 140, why: 'HUD 在跳（在打架）→ 重击' }
        // 打架时先拉近距离：追击（U）比走路快得多（真机= Chase 内部动作）
      if (p.dashWhenFight && cycle % 11 === 0) return { action: 'chase', dir, ms: 260, why: '在打架 → 追击拉近距离（U）' }
      if (p.dashWhenFight && cycle % 7 === 0) return { action: 'dash', dir, ms: 160, why: 'HUD 在跳 → 闪现取消硬直' }
        return { action: 'attack', ms: 130, why: 'HUD 在跳（在打架）→ 普攻' }
      }

      // ③ 平时的节奏：走 → 偶尔攻击 / 跳
      if (p.jumpEvery && cycle % p.jumpEvery === 0) return { action: 'jump', ms: 120, why: '探索节奏 → 跳一下' }
      if (p.heavyEvery && cycle % p.heavyEvery === 0) return { action: 'heavy', ms: 140, why: '节奏性重击' }
      if (p.attackEvery && cycle % p.attackEvery === 0) return { action: 'attack', ms: 120, why: '节奏性挥刀' }
      if (p.moveMs > 0) return { action: 'move', dir, ms: p.moveMs, why: `往${dir === 'right' ? '右' : dir}推进` }
      return { action: 'attack', ms: 120, why: '原地连打' }
    },
  }
}

/**
 * 一次自主连玩的成绩单。给模型看，所以要短、要有信息量。
 * @param {{seconds:number, preset:string, actions:Record<string,number>, events:string[], frames:number, stopped:string}} run
 */
export function summarizeRun(run) {
  const parts = []
  parts.push(`自主玩了 ${run.seconds.toFixed(1)} 秒（${run.preset}：${(PRESETS[run.preset] || {}).desc || ''}）。`)
  const total = Object.values(run.actions).reduce((a, b) => a + b, 0)
  const top = Object.entries(run.actions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('、')
  parts.push(`动作 ${total} 次：${top || '（没有）'}`)
  if (run.events.length) parts.push(`途中：${run.events.slice(0, 6).join('；')}`)
  parts.push(`停止原因：${run.stopped}`)
  if (run.frames) parts.push(`附 ${run.frames} 张途中截图（按时间顺序）。`)
  return parts.join('\n')
}

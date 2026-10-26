import { matchChest, findTransparentChest } from './ui/chest-match.mjs'
import { regionStats, globalBrightRatio, frameDiffRatio, colorRatio, findRedTextRows, findYellowArrow, blueRatioInBox, yellowRatioInBox } from './ui/scan.mjs'
import {
  HUD_BOX, HUD_LUM_MIN, HUD_Y_STEP, HUD_X_STEP,
  PROMPT_BOX, PROMPT_LUM_MIN,
  SUBTITLE_BOX, SUBTITLE_LUM_MIN, SUBTITLE_MIN,
  VFX_LUM_MIN, VFX_DANGER,
  MENU_LIST_BANDS, MENU_DARK_RATIO,
  COMBO_BOX, COMBO_MIN, isComboYellow, MENU_RED_ROWS, ENEMY_ARROW_MIN_SPAN,
} from './games/icey/layout.mjs'
import { classifyScene, StuckDetector } from './games/icey/scene.mjs'
import { HP_BOX, SHIELD_BOX, HP_BASELINE_MAX, SHIELD_BASELINE_MAX } from './games/icey/layout.mjs'

/**
 * 这几个常量现在住在 lib/games/icey/layout.mjs（画面布局与阈值），
 * 这里转出去，保持老引用（selfcheck 等）不用改。
 */
export { HUD_BOX, PROMPT_BOX, SUBTITLE_BOX, SUBTITLE_MIN, VFX_DANGER, MENU_LIST_BANDS, MENU_DARK_RATIO, COMBO_BOX, COMBO_MIN }

/**
 * lib/autoplay.mjs —— 「自己玩一段」的策略引擎（ICEY 专用）
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
 * 🔴 分层（2026-10-24 拆的）：
 *   画面布局（HUD/提示框在哪、多亮算亮）→ lib/games/icey/layout.mjs
 *   像素统计原语（区域亮度、帧差、全屏亮比）→ lib/ui/scan.mjs
 *   这个文件只留**策略**：什么情况做什么动作。
 *   参考 GameScaling 论文的 interface phase / world phase：
 *   界面那一层跨游戏通用，具体世界的知识每个游戏各写各的。
 *
 * 为什么信号只用这两个（可靠、便宜、不误判）：
 *   motion   —— 两帧差异比例。ICEY 待机也有动画，所以「几乎不动」= 被对话框/菜单/
 *               过场挡住，或者到了场景尽头。这时候按 Enter 通常就过去了。
 *   hudKick  —— 左上 HUD（血条那一带）的变化量。战斗中血条/连击数一直在变，
 *               所以这个值高 ≈ 在打架，可以加大攻击频率。
 * ============================================================================
 */

/** 一帧的像素级指标（纯函数） */
export function analyzeFrame(rgba, width, height, prev = null) {
  const n = width * height * 4
  if (!rgba || rgba.length < n) return { ok: false, reason: '帧数据不完整' }

  // 四个区域各自的统计（坐标和亮度门限都来自 lib/games/icey/layout.mjs）
  const hudS = regionStats(rgba, width, height, HUD_BOX, {
    lumMin: HUD_LUM_MIN, yStep: HUD_Y_STEP, xStep: HUD_X_STEP,
  })
  const promptS = regionStats(rgba, width, height, PROMPT_BOX, { lumMin: PROMPT_LUM_MIN })
  const subtitleS = regionStats(rgba, width, height, SUBTITLE_BOX, { lumMin: SUBTITLE_LUM_MIN })
  const vfx = globalBrightRatio(rgba, width, height, VFX_LUM_MIN)

  const hud = hudS.mean
  const hudBright = hudS.brightRatio
  const promptBright = promptS.brightRatio
  const subtitle = subtitleS.brightRatio
  // 「连击数」那一块的黄色占比 —— 目前唯一能干净分开「在探索」和「在打」的信号（见 layout.mjs）
  const combo = colorRatio(rgba, width, height, COMBO_BOX, isComboYellow)
  // 「在不在菜单」：全图红色文字行的条数（见 findRedTextRows 的注释）
  const menuRows = findRedTextRows(rgba, width, height).length
  // 血量和护盾（2026-10-26 用户说明：**蓝色是血，黄色是护盾**）
  const hp = blueRatioInBox(rgba, width, height, HP_BOX)
  const shield = yellowRatioInBox(rgba, width, height, SHIELD_BOX)

  // 黄色实心箭头 = 那个方向有敌人（跟白色空心的"往这走"是两回事）
  const yellowArrow = findYellowArrow(rgba, width, height, { minSpan: ENEMY_ARROW_MIN_SPAN })
  const enemyDir = yellowArrow ? (yellowArrow.x > 0.5 ? 'right' : 'left') : null

  if (!prev || prev.width !== width || prev.height !== height) {
    return { ok: true, width, height, hud, hudBright, promptBright, subtitle, vfx, combo, menuRows, enemyDir, hp, shield, motion: null, hudKick: null }
  }

  const motion = frameDiffRatio(rgba, prev.rgba, 12)
  const hudKick = Math.abs(hud - (prev.hud ?? hud)) / 255

  return { ok: true, width, height, hud, hudBright, promptBright, subtitle, vfx, combo, menuRows, enemyDir, hp, shield, motion, hudKick }
}

/* ============================ 预设 ============================ */

/**
 * 三个预设。都只是「参数不同的同一个状态机」，不是三套代码。
 * moveMs / attackChance 之类可以调，单位都是毫秒。
 */
export const PRESETS = {
  /**
   * 默认：朝 dir 推进（默认右），节奏性挥刀，卡住按确认。
   * ⚠️ desc 里**不能写死方向**。原来写的是「往右推进」，于是 `dir=left` 时摘要照样
   * 说「往右推进」—— 上一轮看着日志以为「dir 参数没传进来」，其实方向是对的，
   * 只是文案在说谎（2026-10-26 查清）。方向由 summarizeRun 按实际 dir 拼。
   */
  advance: {
    desc: '推进：走一段、挥一刀，卡住就按确认键',
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
  /**
   * 探索：**自由探索 + 找宝箱/彩蛋**。
   * 除了走和跳，会定期「掉头换方向」把整张图扫一遍，并且对可疑的地方（墙、角落）砍一刀，
   * 因为 ICEY 的宝箱/彩蛋常藏在可破坏物和岔路尽头。
   */
  explore: {
    desc: '自由探索：扫图找宝箱/彩蛋，可疑的地方就砍一刀',
    moveMs: 1100,
    attackEvery: 3,
    heavyEvery: 7,
    jumpEvery: 4,
    dashWhenFight: false,
    /** 每隔多少循环掉头换方向（把地图扫一遍） */
    flipEvery: 14,
    /** 探索时听到旁白就停一下，跟着指引走 */
    followNarrator: true,
  },
}

/**
 * **行动权重**（用户要求）：不同 preset 下各动作的相对倾向。
 * 用确定性伪随机挑选，保证同样的输入序列得到同样的动作序列（可离线单测）。
 */
/**
 * 可用的连段（全部来自游戏内招式表，用户当前存档**已全部解锁**）。
 * 打架时按权重抽一个打出去 —— 比单发随机 J 伤害高得多。
 */
export const COMBOS = [
  // 地面连段（招式表：扰动（地））
  'jjjjj',
  // 收尾重击（颤振：拔刀斩，击飞小型敌人）
  'jjjji',
  // 穿刺（迭影（地）：范围伤害）
  'jjji',
  // 吸附后追打（磁阱）
  'jjiii',
  // 上挑（震荡）
  'ji',
  // 破盾三连（荡涤：可击碎护盾）
  'iii',
  // ↓+J 凝滞：**按住↓再点J**（串行写法 'sj' 游戏收不到组合键，见 control.mjs 注释）
  's+j',
  // ↑+J 激发：**按住↑再点J**
  'w+j',
  // 破盾后接重击收尾
  'iiij',
  // 后撤步同时挥刀（边退边打，控制距离）
  'a+jjj',
  // ===== 以下来自 BV1314y1k7Zy《艾希基本入门》的**取消衔接**技巧 =====
  // 万能收刀：扰动五连 → 激发凝滞收尾（视频技巧 5）
  'jjjjj|s+j',
  // 小迭影（视频技巧 2「只使迭影前半段」+ 技巧 13「迭影循环」）
  // 迭影(地) 是 J→J→J→I，所以「前半段」= 只按前三下 J，不按最后触发穿刺的那下 I。
  // 依据是视频原话 + skillTree 的序列。（旧写法 'jjji|s+j' 是打完整再收尾，与「前半段」矛盾）
  // ⚠️ 未实测：「前半段」到底停在 jjj 还是更早没有数据 —— 现有工具一次调用往返数秒，
  //    测不出几十毫秒级的硬直差异；也翻过 Assembly-CSharp.dll，只有动作名（ATTACK1..15、
  //    AllowComboTime、CurrentComboFinish）没有帧数。先按视频直译取 jjj。
  'jjj|s+j',
  // 破盾后立刻凝滞定格（荡涤骨架 + 万能收刀）
  'iii|s+j',
  // 磁阱迭影循环（视频技巧 15）：磁阱 → 迭影**前半段**（同上，只按 jjj 不打穿刺）
  'jjiii|jjj',
  // 刺击闪（视频技巧 8）：刺击起步接闪避 → 远距离位移且**省闪避次数**
  'jo',
  // 激发凝滞（技巧 1，难度 1）：↑+J 挑空跃起 → ↓+J 从空中斩落定身
  // 依据 skillTree：「激发=将敌人挑空并跃起」「凝滞=从空中斩杀而下并将空中的敌人定在半空」
  'w+j|s+j',
  // 跳凝滞（技巧 4，难度 1）：把上面「激发」的起手换成跳跃，收刀更快
  // k = 空格（control.mjs 连段表里 k 映射到 jump）
  'k|s+j',
]

/**
 * 连段的**选择权重** —— 依据是社区实战经验（BV1314y1k7Zy 的评论区，
 * 是资深玩家对这套招式的实际评价，不是我猜的）：
 *
 *   磁阱循环（jjiii）：站桩输出、有大量自由时间可随时闪避；吸附本身有伤害，
 *                      吸附前摇还能提前打出处决。对上爱架盾的敌人特别好用 ⇒ **最高**
 *   迭影（jjji）    ：常规攻击里**范围最大**，适合牵制怪群；但穿刺期间**不能取消变招** ⇒ 次高
 *   颤振（jjjji）   ：收尾重击、击飞小型敌人 ⇒ 中
 *   扰动五连（jjjjj）：基础连段 ⇒ 中
 *   震荡（ji）      ：上挑起手 ⇒ 中
 *   凝滞/激发       ：控制起手，主要用于打断 ⇒ 中低
 *   荡涤（iii）     ：能破盾，但**卡手严重**（评论原话「逆天的卡手程度」）⇒ **最低**
 */
export const COMBO_WEIGHTS = {
  'jjiii': 6,
  'jjji': 5,
  'jjjji': 4,
  'jjjjj': 3,
  'ji': 3,
  'iiij': 2,
  's+j': 2,
  'w+j': 2,
  'a+jjj': 2,
  'iii': 1,
  // 取消衔接系列（BV1314y1k7Zy）：都是"打一半就切走"，理论上更高效，
  // 但需要节奏，暂给中等权重观察效果
  'jjiii|jjj': 3,
  'jjj|s+j': 3,
  'jjjjj|s+j': 2,
  'iii|s+j': 1,
  'jo': 2,
  // 激发凝滞 / 跳凝滞：难度都是 1（作者标的最基础两招），起手快、能定身，
  // 给中等权重 —— 定住敌人对后续连段是加成
  'w+j|s+j': 2,
  'k|s+j': 2,
}

export const ACTION_WEIGHTS = {
  advance: { move: 5, attack: 3, heavy: 1, jump: 1, chase: 1 },
  // 战斗权重（用户要求：加大位移/闪避比重 —— 破盾后挨打会倒地，先活着才有输出）
  // 用户要求两轮调整后：**攻击欲望拉满、位移压到最低**（打完一套就贴脸继续压，别来回走）
  // ⚠️ 这里**不再有 execute**（2026-10-24 删）。
  //    处决必须等「黄圈 + 头顶 L」出现（用户描述，见 execute-prompt.mjs），
  //    而把它当普通动作放进权重，等于每 27 个战斗动作里有 2 个是**盲按 L 碰运气**——
  //    没有可处决目标时 L 是无效按键，纯浪费一个动作位。
  //    现在处决只走「检测到提示 → 立刻按 L」那一条路（优先级最高，见 decide 里 executePrompt 分支）。
  // 两个特殊技权重下调（2026-10-25 用户要求）。
  // 它们消耗生命换免疫，性价比不如连段/重击；原来各占 1/25 ≈ 4%，
  // 现在各占 0.4 / 0.3，落到 1.7% / 1.3%。
  // 三档战斗模式（2026-10-26 用户定）：
  //   一档 healthy   未破盾 + 血量健康        → 全力输出
  //   二档 cautious  未破盾+血少 / 破盾+血多   → 收敛
  //   三档 danger    破盾 + 血量不健康         → 最保守
  //
  // 注意：**三档都不撤**。用户明确说过「不要撤，降低攻击欲望就行」。
  // dash 在这里是走位权重不是逃命；wait 也不是站着挨打，是「少出手、看清再打」——
  // 一档完全没有 wait。
  // combo 权重 2026-10-26 上调（用户要求「增加打完连招的权重」）：
  // 一档从 10 提到 14 —— 连段是主要输出，重击和普攻只是穿插。
  fight: { combo: 14, heavy: 6, attack: 4, chase: 1, dash: 1, storm: 0.4, shade: 0.3 },
  fightCautious: { combo: 7, heavy: 4, attack: 3, chase: 2, dash: 2, wait: 1, storm: 0.2, shade: 0.2 },
  fightDanger: { combo: 4, heavy: 2, attack: 2, chase: 2, dash: 2, wait: 3, storm: 0.1, shade: 0.1 },
  explore: { move: 4, jump: 2, attack: 2, heavy: 1, dash: 1 },
}

/** 旁白/字幕检测框：屏幕下方中间那条（ICEY 的旁白是白字，压在画面下三分之一） */
/** 字幕白字占比阈值：超过就认为「旁白在说话」 */

/**
 * 环境感知网格：把画面切成 32×18 格，逐格算亮度/饱和度，用来找
 * ① **明显的可破坏物**（小而高饱和、跟周围背景反差大的块）
 * ② **环境接缝**（背景里不该出现的竖直断裂/色块错位 → 疑似隐藏房间入口）
 *
 * 🔴 用户指出的设计错误（2026-10-23）：
 *    之前是「每 5 个循环对可疑位置砍一刀」—— 那是瞎砍。可破坏物本身很显眼，
 *    应该**先看见再打**；隐藏房间更不是靠乱挥刀找的，要靠对环境的结构分析。
 */
export const GRID_COLS = 32
export const GRID_ROWS = 18
/**
 * **宝箱**判定（用户 2026-10-23 纠正）：
 *   宝箱是**蓝色**的，有时是**半透明**的，中间都有**钱的标识**（$）。
 *   —— 不是我之前以为的「高饱和橙色箱子」。
 * 判定思路：格子偏蓝（B 明显大于 R/G）+ 有一定饱和度；半透明箱子的蓝色会淡，所以阈值分两档。
 */
/**
 * 敌人要放大的预警：画面高亮像素占比超过它就先闪。
 * 实测数据（2026-10-23 用户 24 分钟战斗，2476 采样）：
 *   大伤害（一次掉 >5%）前 1.5 秒 vfx ≈ 6.61%；全局平均 4.09%
 *   小伤害前 1.5 秒 vfx ≈ 4.42%
 * 所以 5.5% 是一个有依据的分界，而不是拍脑袋。
 */

/**
 * **宝箱**判定 —— 已用真实样本校准（2026-10-23 用户展示，shots/now-chest.png）
 *
 *   真实外观：**深色（近黑）面板 + 青色圆角边框 + 中间一个大号青色 $**
 *   ⇒ 关键特征不是「一片蓝」，而是「**暗底上的青色线条**」。
 *
 * 同一帧内实测对照：
 *   宝箱区    : 青色 4.6%，暗像素 77.8%，平均亮度 44.3
 *   角色(蓝剑): 青色 4.9%，暗像素 57.8%，平均亮度 61.1   ← 亮度/暗度不同，能分开
 *   背景各处  : 青色 0%
 */
/** 模板匹配阈值：真宝箱 0.864，92 张负样本最高 0.52 ⇒ 0.62 余量充足 */
/**
 * 菜单判定阈值（识别「停在强化/暂停/系统界面」）。
 *
 * 实测（2026-10-23 用 6 张菜单截图 + 7 张实机帧校准）：
 *   菜单帧 listBands = 3~15（多数 ≥9），darkRatio 0.50~0.95
 *   实机帧 listBands = 1~8，darkRatio 0.43~0.68
 * 判据：listBands ≥ 9 或 darkRatio > 0.90。
 * ⚠️ 不需要很准：识别成菜单后的动作是**按 Esc**（游戏里只是开关暂停菜单），代价极低；
 *    真正要防的是「在升级页误按 Enter 花钱」，那条用下面的『菜单里禁止 Enter』硬规则。
 */

export const CHEST_MATCH_MIN = 0.62

/**
 * 隐藏房间指纹阈值（2026-10-24 用两张真实截图实测标定）。
 *   低饱和高亮（接近白/灰的亮像素）：实测 0.35% / 0.42%
 *   高饱和亮青（网格线/光带/三角）：  实测 6.78% / 7.03%
 * 这两个数一起看才稳：单独用任何一个，普通场景都可能落进来。
 * 门槛留了余量（低饱和上限取 1.2%、青色下限取 4.5%）——
 * 因为角色/地面会把低饱和拉高，宁可漏认房间也不要在普通场景误判。
 */
export const GRID_ROOM_LOW_SAT_MAX = 0.012
export const GRID_ROOM_CYAN_MIN = 0.045
export const CHEST_CYAN_MIN = 0.03     // 青色像素占比下限（$ 符号 + 边框）
export const CHEST_DARK_MIN = 0.70     // 暗像素占比下限（近黑面板）
export const CHEST_LUM_MAX = 60        // 平均亮度上限（排除亮背景上的青色特效）
export const CHEST_MIN_CELLS = 3
/** 宝箱连通块的最大格数：真宝箱只占几格（32×18 网格下约 10 格） */
export const CHEST_MAX_CELLS = 20
/** 接缝判定：某一列亮度与左右邻列中位数差异超过它（0~255） */
export const SEAM_DIFF = 22

/* ============================ 策略状态机 ============================ */

/** 判定「几乎不动」的阈值：低于它就认为被挡住了 */
export const STILL_MOTION = 0.004
/**
 * HUD 区域平均亮度的帧间变化阈值（0~1 的比例）。
 *
 * 🔴 2026-10-25 复查：**它不再参与战斗判断**。
 *   它量的是「左上 HUD 那一带的平均亮度变了多少」，战斗帧中位数只有 0.17%，
 *   而 0.02（2%）是它的 12 倍 —— 真打起来永远够不着。
 *   它真正会跳起来的场合是菜单开合、场景切换、过场 —— 那是 UI 切换。
 *   拿它判战斗只会制造假阳性（实测：暂停菜单一关就被判成「进入战斗」）。
 *   常量留着，是准备给「识别 UI 大幅切换」用的；要用请先真机量一遍再定。
 */
export const FIGHT_HUDKICK = 0.02
/**
 * 战斗判据：
 *   不能靠敌人血条 —— 用户指出「大部分怪物没有血条」；
 *   也不能靠 hudKick —— 它量的是 UI 亮度的帧间变化，战斗时够不着阈值，
 *     只有菜单/场景切换才会跳（2026-10-25 复查，见上面 FIGHT_HUDKICK 的注释）。
 *
 * 可靠信号是画面活跃度（连续的 100ms 帧实测）：
 *   战斗中 motion 中位 24.6%（刀光 / 敌人动作 / 伤害数字满天飞）
 *   空地上 motion 中位  0.7%（角色站着，几乎不动）—— 差 34 倍
 *   2026-10-25 复核：空地 / 强化台旁各 40 帧等间隔连拍，中位 1.20% / 1.31%。
 *
 * 🟡 8% → 15%（2026-10-25 用用户录屏复核）：
 *   拿 173 秒录屏抽 300 帧（5fps）逐帧算，motion 分成四档，中间是空的：
 *     静止            0–2%
 *     原地放技能/被击  10–13%（帧 108-111、219-221、228-231 都是艾希在放技能，场上没敌人）
 *     真战斗          25–46%（帧 294-297）
 *     黑屏过场         90%+（帧 83 的 96.74% 是黑屏切回游戏；那种帧 hudBright=0，
 *                      会先被「没进游戏」分支拦掉，不会走到这里）
 *   8% 的线会把「空挥一个技能」当成开打，所以抬到 15% —— 落在 13% 和 25% 中间。
 * 单帧高 motion 也可能是刚放了一招，所以还看**最近 8 次里高活跃的比例**。
 */
export const FIGHT_MOTION = 0.15        // 单帧算「活跃」的门限

/**
 * 「连击数多久没涨就当是在朝空气挥」。
 * 1500ms 是拿机制推的，没实测定标（诚实标注）：用户说明过「连段断掉的原因之一是
 * 一段时间没打到敌人」，而插件一次决策间隔约 0.69 秒 —— 1500ms ≈ 连续两次决策都没涨。
 * 比这更短会把「出招前摇里本来就没涨」误判成打空；更长则白挥两三秒。
 */
export const COMBO_STALE_MS = 1500

/**
 * 两次「转身」之间至少隔多久。转身要按方向键 90ms，代价是约 35px 位移（实测），
 * 但它同时会把身体挪向那一侧 —— 所以不能每帧翻面，否则人会原地来回抽搐。
 */
export const FACE_COOLDOWN_MS = 1200

/**
 * 血线告急的判据：血掉到基线的 30% 以下、盾也基本没了 ⇒ 进入「低血模式」。
 *
 * 🔴 2026-10-26 用两条命换来的，而且第一版写错了，这一版是用户纠正后的：
 *    我起初把「撤」理解成「离开战斗区」，于是低血就朝反方向跑。
 *    **但 ICEY 一进战斗，场景两侧会落下屏障，根本没有出口** —— 那不是撤退，是往墙上撞。
 *
 *    所以在场地里「撤」只能是**少挨打**，手段只有四种：
 *      ① 拉距离：后撤一步 / 闪一下，让敌人的攻击打空（不是走人）
 *      ② 无敌帧：O 闪避本身带短无敌；湍流(8)/流场(9) 是持续免疫但**消耗生命**，
 *         低血时花血换免疫是亏的，不该当保命用
 *      ③ 续命：**处决(L)** 回血回盾掉结晶 —— 这是唯一能让血条变长的动作。
 *         它已经在 decide() 里排在战斗分支**之前**（executePrompt 分支，全局最高优先级），
 *         所以下面这段不会压住处决，也不该压
 *      ④ 不打：等敌人收招，用短连段打一套就停，不追完整套
 *
 *    ⇒ 结论：低血不是「打得保守点」，也不是「跑掉」，是「换一种打法撑完这一场」。
 */
export const PANIC_HP_RATIO = 0.3
export const PANIC_SHIELD_RATIO = 0.2
/**
 * 低血模式下「后撤步」的最小间隔。它带位移，太频繁会在屏障之间来回横跳。
 * 名字刻意不叫 retreat —— 场地里没有 retreat。
 */
export const BACKOFF_COOLDOWN_MS = 2000
export const FIGHT_WINDOW = 8           // 滑动窗口长度（次决策）
export const FIGHT_ACTIVE_RATIO = 0.4   // 窗口里 ≥40% 活跃 ⇒ 判定在战斗
export const FIGHT_HOLD_MS = 6000       // 开打后粘滞这么久（战斗有间歇，别抖）
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
//
// 🔴 **脱困阶梯里不再有 Enter**（2026-10-24 用户问「为什么要按 Enter」，答不上来）。
//    之前那一格是「盲按 Enter 试试」，理由是「ICEY 只有 Enter 一个互动键」。
//    但看不见提示框时按 Enter 只有两种结果：
//      ① 什么也没发生（白按一次）
//      ② 打开了菜单（强化台 = 会花钱；暂停菜单 = 可能选中「退出」）
//    ② 是有害的，① 也没有收益 ⇒ 这一格删掉。
//    Enter 现在**只由「看到白字提示框」驱动**（那是游戏自己画的字，可信），
//    见上面 promptBright 那段；且限次、限间隔、菜单态禁用。
// 阶梯变成：退一步 → 跳 → 掉头（**不含 Enter，不含 Esc，也不含重击**）。
//   Enter：看不见提示框时按它只可能白按或打开菜单（用户 2026-10-24 问出来的）。
//   Esc  ：本来没菜单却按它会把暂停菜单打开，菜单由专门分支处理。
//   重击 ：**和「别盲砍可疑位置」直接冲突**（用户早就要求过：可破坏物很明显，别乱挥）。
//          卡住可能是剧情锁/碰撞体顶住，此时重击只会挥空刀、露破绽。
//          「打可破坏物」这件事由接缝分支负责（看到背景竖直断裂才走过去打，有依据再动手）。
// 剩下的几步都是**无损试探**：退一步能解开碰撞体互顶，跳能过台阶/矮墙/藤蔓，
// 跳+上冲能钩到空中的入口（见 jump-up 那段的注释）。
// 全都无效就判定走不通、掉头 —— 顺序是「先试最便宜的，再接受过不去」。
//
// 2026-10-24 加了第三级 'jump-up'：用户指出「部分场景的入口在空中」，而原来只有
// 普通的跳（140ms，原地起跳高度有限），够不到高处的洞口/台子。
// PC 版的冲刺是四方向的（招式表里的 FlashUp/Down/Left/Right），但策略层从来没调用过
// 垂直方向 —— 整个 autoplay.mjs 里 'up'/'down' 一个字面量都没有。
export const UNSTUCK_LADDER = ['back', 'jump', 'jump-up']
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
 * 「有互动提示框」的判据：提示区里白字（亮度>200）占比。
 *
 * 实测（2026-10-23，原分辨率 + 抢到前台）：
 *   没有提示框 ≈ 0.019%     有提示框（「⏎: 开启强化」）≈ 0.23% ~ 0.40%
 * 差 10~20 倍，所以 0.08% 这个阈值很安全。
 * ⚠️ 之前判定失败是因为两个错：把画面缩到 400 宽（细笔画糊掉）+ 没抢前台（提示框根本不渲染）。
 */
export const PROMPT_MIN = 0.0008

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
  // 战斗判据用的滑动窗口与粘滞时间（见 FIGHT_MOTION 注释）
  const motionWindow = []
  let fightingUntil = -Infinity
  // 「真在挨打」信号。连击数测的是「正在有效进攻」，挨打会把它清零（2026-10-25 用户说明：
  // 连击一段时间没打到敌人就断；护盾破了之后受击也断），所以挨打必须单独认。
  // 场景归类 + 卡住检测（2026-10-26 新增）。
  // 目的：以前每个分支各看各的特征，没有地方回答「现在到底是什么局面」，
  // 于是遇到没有对应分支的情况（剧情锁/商店/需要解谜的门）只会掉进默认的「继续往右走」，
  // 一次次撞同一面墙。现在先归类，卡住了就停手报告，让人介入。
  const stuckDetector = new StuckDetector()
  let hpBaseline = 0
  let shieldBaseline = 0
  /**
   * 战斗档位遥测（2026-10-26 加）。
   *
   * 为什么需要：三档（healthy/cautious/danger）上线后实机跑了好几轮，日志里
   * **一次都没出现过低档位文案**，一直是「血量和护盾都还够」。但光看这句话分不清是
   *   ① 真的没掉到阈值以下
   *   ② hp/shield 检测被背景污染（一直读到接近满值）
   *   ③ hpBaseline 被早期某个异常高值锚死，ratio 永远接近 1
   * 所以把「原始读数 / 基线 / ratio / 档位切换」全记下来。看一轮就知道是哪种。
   *
   * 这里只记录、不改变决策 —— 先测清楚再决定要不要动阈值。
   */
  const combatStats = {
    /** 参与过档位判定的战斗帧数 */
    frames: 0,
    /** 各档位各占多少帧 */
    tierFrames: { healthy: 0, cautious: 0, danger: 0 },
    /** 各档位被「切进去」几次（初始那一次不算切换） */
    tierEntered: { healthy: 0, cautious: 0, danger: 0 },
    /** 见过的最低原始读数（hp/shield 都是「框内像素占比 0~1」） */
    minHp: null,
    minShield: null,
    /** 见过的最低比例（相对基线） */
    minHpRatio: null,
    minShieldRatio: null,
    /** 基线最终值 —— 如果它明显高于满血实测值(0.69/0.10)，说明被污染锚死了 */
    hpBaseline: 0,
    shieldBaseline: 0,
    /** 有多少次读数顶到物理上限、被夹住（说明污染帧真的出现过） */
    baselineClamped: 0,
    /** 档位切换记录（最多留 8 条，防日志爆） */
    changes: [],
    lastTier: null,
  }
  const noteTier = (from, to, hpNow, shieldNow, hpRatio, shieldRatio, now) => {
    combatStats.changes.push({
      at: now, from, to,
      hp: +hpNow.toFixed(4), shield: +shieldNow.toFixed(4),
      hpRatio: +hpRatio.toFixed(3), shieldRatio: +shieldRatio.toFixed(3),
      hpBaseline: +hpBaseline.toFixed(4), shieldBaseline: +shieldBaseline.toFixed(4),
    })
    if (combatStats.changes.length > 8) combatStats.changes.shift()
  }
  let lastScene = null
  let lastSceneWhy = ''
  let lastBright = null
  let damagedUntil = -Infinity
  let dialogueInteracts = 0     // 旁白/对话里按确认键的次数（不受菜单那 3 次限制）
  let subtitleStreak = 0
  let lastSubtitleAt = -Infinity
  let flipAt = 0
  let menuEscCount = 0
  let lastMenuEscAt = -Infinity
  let lastExecuteAt = -Infinity
  let lastComboAt = -Infinity    // 上一次出连段的时间（用于打完接着续）
  // ── 朝向 / 打空 记账（2026-10-26 新增，见 combat 分支里的长注释）──────────
  let facing = dir               // 当前朝向。**实测朝向 = 最后一次移动方向**，初始等于探索方向
  let prevCombo = null           // 上一帧读到的连击数（用来判断它有没有在涨）
  let comboGainAt = 0            // 连击数最后一次上涨的时间
  let lastFaceAt = -Infinity     // 上一次主动转身的时间（限流用）
  let lastBackoffAt = -Infinity // 上一次低血后撤步的时间（限流用）
  let lastDodgeAt = -Infinity
  let lastGetUpAt = -Infinity
  let lastStrikeAt = -Infinity
  let lastSeamAt = -Infinity
  let promptInteracts = 0          // 同一段卡住里，靠提示框按过几次 Enter
  let rngSeed = 1013904223      // 确定性伪随机：同样的输入序列 → 同样的动作序列

  return {
    preset: resolved,
    desc: p.desc,
    get cycle() { return cycle },
    get stillStreak() { return stillStreak },
    get fighting() { return fighting },
    get dir() { return dir },
    get interactCount() { return interactCount },
    get menuEscCount() { return menuEscCount },
    /** 战斗档位遥测快照（game.mjs 每轮结束读它写进摘要；不改决策） */
    get combatStats() { return combatStats },

    /**
     * @param {{motion:number|null, hudKick:number|null}} m 画面指标
     * @param {{now:number}} [clock] 时间（毫秒，外部传入便于测试）
     * @returns {{action:string, dir?:string, ms?:number, why:string}}
     */
    decide(m, clock = { now: 0 }) {
      const motion = m.motion ?? 1
      const hudKick = m.hudKick ?? 0
      const bright = m.hudBright ?? 1
      // ⓪ **菜单必须最先判**（比「没检测到 HUD」还早）。
      //   理由（2026-10-25 实机实测）：真暂停菜单里血条被压暗到 hudBright = 0.00%，
      //   和黑屏过场一模一样。如果让「没检测到 HUD」先判，菜单会走进「按确认键推进」，
      //   永远按 Enter 关不掉 —— 而 Enter 在强化页里恰恰是「升级」，会花钱。
      //   唯一分得开的是「左侧文字条带」：菜单 9~15 行，黑屏/实机 1~2 行。
      //   ⚠️ 但 listBands 单独也不够：明亮场景里物体的横向边缘会被数成「文字条带」，
      //      2026-10-25 实测撞到过 listBands=9~10 而压暗只有 11% 的假菜单。
      //      所以配一个压暗下限 0.4，三类才彻底分开：
      //        真菜单   listBands 9~15 + darkRatio 0.50~0.95
      //        明亮误判 listBands 9~10 + darkRatio 0.11
      //        黑屏过场 listBands 2    + darkRatio 0.92
      {
        // ── 先归类，再决策 ────────────────────────────────────────────
      // 卡住检测先跑：它看的是「有没有进展」，跟本帧具体做什么动作无关。
      const stuckNow = stuckDetector.update(lastScene, m, clock.now)
      const cls = classifyScene(m, {
        stuck: stuckNow,
        stuckMs: stuckDetector.stuckMsNow(clock.now),
      })
      lastScene = cls.scene
      lastSceneWhy = cls.why

      // 卡住了就别再动 —— 继续撞只会白烧真机时间和注意力。
      // 返回 wait 会让 icey_play 判「没有进展」然后停手，把画面交回人。
      if (cls.scene === 'stuck') {
        return {
          action: 'wait', ms: 800,
          why: `卡住了：${cls.why}。不再继续撞墙，停手等指示`,
        }
      }

      const menuRows0 = m.menuRows ?? 0
        if (menuRows0 >= MENU_RED_ROWS) {
          stillStreak = 0
          if (clock.now - lastMenuEscAt > 1400) {
            lastMenuEscAt = clock.now
            menuEscCount++
            return {
              action: 'pause', ms: 110,
              why: `看到菜单里的红色警告（${menuRows0} 条红色文字行）→ 按 Esc 退出（第 ${menuEscCount} 次）`,
            }
          }
          return { action: 'wait', ms: 300, why: '等菜单关闭' }
        }
        menuEscCount = 0
      }
      // **战斗检测**：不能靠敌人血条（用户 2026-10-24：大部分怪没有血条）。
      //
      // 🟢 现在的主信号是「左上角那串黄色的连击数」（见 layout.mjs 的 COMBO_BOX）：
      //   21 分钟录屏实测 —— 探索/剧情 0.000%，战斗 1.59% / 2.616% / 2.666%，中间是空的。
      //   连击数只在战斗中累加，仗一打完就归零消失。它是**产物**，不是「画面像在打」的迹象。
      //
      // 🔴 hudKick 不能参与战斗判断（2026-10-25 复查）：
      //   hudKick = |HUD 区域平均亮度 - 上一帧| / 255。战斗帧中位数只有 0.17%（= 0.0017），
      //   而 FIGHT_HUDKICK = 0.02（= 2%），差 12 倍 —— 战斗永远够不着。
      //   它真正会跳的是菜单开合、场景切换，留在判据里只会制造假阳性。
      //
      // 🔴 motion 也不能参与（2026-10-25 同一段录屏证伪）：
      //   探索时镜头一直在动（跑动、平移、切场景），motion 中位 53.8%；
      //   战斗时镜头被屏障锁住，反而只有 34.1% —— 方向是反的。
      //   之前「空地 0.7% vs 战斗 24.6%」那组对比，只覆盖了「角色站着」和「在打」，
      //   漏掉了「在跑动」这一档，所以结论一直是对的假象。
      //   这段统计留着（可能有别的用途），但**不再参与** fightingNow。
      motionWindow.push(motion)
      if (motionWindow.length > FIGHT_WINDOW) motionWindow.shift()
      const activeN = motionWindow.reduce((a, v) => a + (v >= FIGHT_MOTION ? 1 : 0), 0)
      const activeRatio = activeN / motionWindow.length
      // 掉血 = 血条区亮像素比上一帧少了一截（血条变短）。回血时它会涨回来。
      const tookDamage = lastBright !== null && bright < lastBright - 0.004
      lastBright = bright
      if (tookDamage) damagedUntil = clock.now + 3000
      const recentlyDamaged = clock.now < damagedUntil
      // 战斗屏障也算「还在打」：屏障只在敌人清光后消失，
      // 所以它开着就证明这场仗没结束（2026-10-24 用户说明的机制）。
      // 补的正是「敌人倒地、连击断了但屏障还亮着」那种空档。
      const comboRatio = m.combo ?? 0
      const fightingNow = comboRatio >= COMBO_MIN
        || m.barrier === true
        || recentlyDamaged
      // 粘滞：战斗有间歇，一旦开打就保持 FIGHT_HOLD_MS，避免在「打一下停一下」里反复抖动
      if (fightingNow) {
        fighting = true
        fightingUntil = clock.now + FIGHT_HOLD_MS
      } else if (clock.now > fightingUntil) {
        fighting = false
      }
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

      // ⓪b **跟随旁白**：屏幕下方出现白字（旁白/对话）时，先按确认把话听完。
      //     这是用户要的「跟随旁白的指引」——旁白在讲，先别乱跑。
      const subtitle = m.subtitle ?? 0
      if (subtitle >= SUBTITLE_MIN) {
        subtitleStreak++
        // 衰减而不是清零：一直在说话也不能把「卡住」这件事掩盖掉（否则永远不收敛）
        stillStreak = Math.max(0, stillStreak - 1)
        if (subtitleStreak >= 2 && clock.now - lastSubtitleAt > 800 && dialogueInteracts < 40) {
          lastSubtitleAt = clock.now
          dialogueInteracts++
          return {
            action: 'interact', ms: 110,
            why: `旁白在说话（下方白字 ${(subtitle * 100).toFixed(1)}%）→ 按确认把话听完（第 ${dialogueInteracts} 次）`,
          }
        }
        return { action: 'wait', ms: 250, why: '正在听旁白' }
      }
      subtitleStreak = 0

      // ① 原地踏步 ⇒ 被门/墙/解谜挡住。判据用「2.5 秒净进展」而不是相邻帧，
      //    否则待机动画（1.5%）会让人以为一直在往前走。
      // ⚠️ **打架时不进脱困阶梯**：打怪本来就不会「净前进」，画面也会周期性抖动。
      //    真机上因此误判过卡住 → 连按 6 次 Enter（战斗里按 Enter 毫无意义，还有进菜单的风险）。
      const stuck = !fighting && (
        (m.progress !== null && m.progress !== undefined && m.progress < PROGRESS_MIN)
        || motion < STILL_MOTION
      )
      if (stuck) {
        stillStreak++
        const pct = (m.progress === null || m.progress === undefined) ? null : m.progress
        const whyPrefix = pct === null
          ? `画面几乎不动（${(motion * 100).toFixed(2)}%）`
          : `2.5 秒净进展只有 ${(pct * 100).toFixed(1)}%（原地踏步）`
        // 一轮阶梯走完 ⇒ 判定这条路走不通，掉头换边探索。
        // ⚠️ 这段必须放在阶梯**之前**：之前放在最后，而停止阈值又等于阶梯长度，
        //    结果掉头永远执行不到（真机实测：卡在门上 11 秒就直接放弃了，没掉头）。
        // ① 看到互动提示框（「⏎: 开启强化」那种白字）⇒ 直接按 Enter。
        //    这是最可信的信号：字是游戏自己画的，比猜门能不能开强得多。
        //    注意：确认键按满后要**继续往下走阶梯**，不能在这里死等 —— 否则永远到不了「掉头」
        // 同一段卡住里最多靠提示框按 2 次 Enter：
        // 按了没反应说明这不是「按一下就走」的东西（比如强化台，开的是菜单），
        // 继续按只会反复开关菜单/花冤枉钱 —— 该退回脱困阶梯。
        if (m.promptBright !== null && m.promptBright !== undefined
            && m.promptBright >= PROMPT_MIN && interactCount < MAX_INTERACTS
            && promptInteracts < 2) {
          // 间隔 3 秒：强化台的提示框按一次是「开启强化」，菜单里再按一次就是**花钱升级**了。
          // 真机上 0.9 秒的间隔太急，改成 3 秒给玩家/模型留出反应余地。
          if (clock.now - lastInteractAt > 3000) {
            lastInteractAt = clock.now
            interactCount++
            promptInteracts++
            return {
              action: 'interact', ms: 120,
              why: `看到互动提示框（白字 ${(m.promptBright * 100).toFixed(2)}%）→ 按 Enter 互动`,
            }
          }
          return { action: 'wait', ms: 200, why: '刚按过确认键，等提示框的结果' }
        }

        // 一轮阶梯 + 末尾「掉头」组成循环：退一步 → 跳 → 掉头。
        // 两步无效就承认过不去，别在同一面墙上耗着。
        const slot = (stillStreak - 1) % (UNSTUCK_LADDER.length + 1)
        if (slot === UNSTUCK_LADDER.length) {
          dir = dir === 'right' ? 'left' : 'right'
          return {
            action: 'move', dir, ms: 1600,
            why: `${whyPrefix} → 退一步、跳、跳+上冲都试过了，判断这条路走不通，掉头往${dir === 'left' ? '左' : '右'}走`,
          }
        }
        // 脱困阶梯：两步**无损物理试探**（原因见 UNSTUCK_LADDER 上方注释）
        const ladder = UNSTUCK_LADDER[slot]
        if (ladder === 'back') {
          // 420ms 是实测出来的：按住 D 100/200ms 背景**一点不动**（有约 200ms 起步死区），
          // 260ms 只挪 2px（0.3% 画面宽，退不开），400ms 才明显移动。
          // 原来随手写的 260ms 几乎等于没退。
          return { action: 'move', dir: dir === 'right' ? 'left' : 'right', ms: 420, why: `${whyPrefix} → 反向挪一步（解开碰撞体互顶）` }
        }
        if (ladder === 'jump') return { action: 'jump', ms: 140, why: `${whyPrefix} → 跳一下试试（台阶/矮墙/藤蔓）` }
        if (ladder === 'jump-up') {
          // 部分场景的入口在**空中**（用户 2026-10-24 指出）。
          //
          // 真机实测（2026-10-24，迷路森林）：
          //   dash up（地面直接按 W+O）  → 往**右**冲了约 400px，人没离地
          //   dash left                 → 正常往左冲
          //   `空格 → 按住W → 点O`     → **垂直飞到画面顶部**（整条竖直光柱）
          //
          // 所以 ICEY 的上冲**必须在空中**才出得来；地面上按 W+O 会退化成朝右冲。
          // 用 combo 一次发完（跳完立刻按住 W 点 O），不要分成两个 action ——
          // 中间一旦等落地，就再也冲不起来了。
          return {
            action: 'combo',
            keys: 'k|w+o',
            why: `${whyPrefix} → 跳 + 空中上冲（够高处的入口；地面按上冲无效）`,
          }
        }

        return { action: 'jump', ms: 140, why: `${whyPrefix} → 跳一下试试` }
      }
      // 有进展时**衰减**而不是清零：
      // 原地踏步往往是「撞一下 → 相机抖一下 → 又不动」的锯齿，严格清零会让
      // 脱困阶梯永远走不到「掉头」那一步（真机实测：40 秒里只按了 4 次确认键）。
      stillStreak = Math.max(0, stillStreak - 1)
      if (stillStreak === 0) promptInteracts = 0

      // ①b **处决优先级最高**（用户要求）：怪物身上出现黄圈、头顶出现 L ⇒ 立刻按 L。
      //     处决能**回血、回护盾、掉能量结晶**，收益远高于多打两下。
      if (m.executePrompt) {
        lastExecuteAt = clock.now
        return {
          action: 'execute', ms: 130,
          why: `看到处决提示（黄圈 + 头顶 L，位置 x=${((m.executeX ?? 0.5) * 100).toFixed(0)}%）→ 按 L 处决（回血回盾掉结晶）`,
        }
      }
      // 处决之后：地上会有能量结晶，**长按 J 吸收并释放超载**
      if (lastExecuteAt >= 0 && clock.now - lastExecuteAt > 700 && clock.now - lastExecuteAt < 3200) {
        lastExecuteAt = -Infinity
        return { action: 'overload', ms: 1200, why: '刚处决完 → 长按 J 吸收能量结晶并释放超载' }
      }

      // ② 在打架：先保命，再输出
      if (fighting) {
        // **预警闪避**（从 24 分钟实战数据学到的规则）：
        // 画面高亮突然窜高（>5.5%）几乎都对应敌人放大招 —— 此时先闪，比贪一刀划算得多。
        if ((m.vfx || 0) >= VFX_DANGER && clock.now - lastDodgeAt > 900) {
          lastDodgeAt = clock.now
          return {
            action: 'dash', dir: dir === 'right' ? 'left' : 'right', ms: 200,
            why: `画面亮闪 ${((m.vfx || 0) * 100).toFixed(1)}% ≥ ${(VFX_DANGER * 100).toFixed(1)}%（数据上大伤害前就是这样）→ 先闪`,
          }
        }
        // ── 索敌：先搞清楚敌人在哪边，再决定往哪打 ──────────────────
        //
        // 2026-10-26 用户指出：「战斗时的索敌是不是有问题」。
        // 查下来确实有问题 —— 战斗分支里所有动作用的都是 dir（探索方向，一直是 'right'），
        // 出招本身又不带方向，所以角色相当于永远朝右面前方挥刀。
        // 敌人在身后或左边时，等于一直在打空气。
        //
        // 能用来定位敌人的信号只有两个（画面里没有通用的敌人检测）：
        //   ① m.enemyDir —— 屏幕中央的黄色实心箭头，指向视野外的敌人
        //   ② m.executeX —— 处决提示（黄圈+头顶L）的位置，那就是某个敌人的位置
        // 两个都没有时，保持当前朝向 —— 但**没有键能可靠地把朝向甩过去**（见下）。
        let foeDir = null
        if (m.enemyDir === 'left' || m.enemyDir === 'right') {
          foeDir = m.enemyDir
        } else if (typeof m.executeX === 'number') {
          const dxe = m.executeX - 0.5
          if (Math.abs(dxe) > 0.08) foeDir = dxe > 0 ? 'right' : 'left'
        }

        // ── 战斗三档：按「护盾 × 血量」分 ────────────────────────────
        //
        // 用户 2026-10-26 定的分法（HUD 上蓝色是血、黄色是护盾）：
        //   一档 healthy  未破盾 + 血量健康        → 全力输出
        //   二档 cautious 未破盾+血少 / 破盾+血多   → 收敛
        //   三档 danger   破盾 + 血量不健康         → 最保守
        //
        // ⚠️ 原来这里有一条「掉到基线 72% 就先闪开」，已被用户否掉：
        //    实测 120 秒触发 42 次 dash，几乎每三秒闪一次，等于放弃输出。
        //    现在改成**不撤**，只按档位调节攻击欲望。
        const hpNow = m.hp ?? 0
        const shieldNow = m.shield ?? 0
        // 基线 = 见过最大值，但**夹住物理上限**（见 layout.mjs 的 HP_BASELINE_MAX）。
        // 不夹的话，一帧剑光/爆闪就能把分母永久抬高，之后所有 ratio 都偏低。
        if (hpNow > hpBaseline) {
          hpBaseline = Math.min(hpNow, HP_BASELINE_MAX)
          if (hpNow > HP_BASELINE_MAX) combatStats.baselineClamped++
        }
        if (shieldNow > shieldBaseline) {
          shieldBaseline = Math.min(shieldNow, SHIELD_BASELINE_MAX)
          if (shieldNow > SHIELD_BASELINE_MAX) combatStats.baselineClamped++
        }
        const hpRatio = hpBaseline > 0 ? hpNow / hpBaseline : 1
        const shieldRatio = shieldBaseline > 0 ? shieldNow / shieldBaseline : 1
        const hpOk = hpRatio >= 0.6
        const shieldOk = shieldRatio >= 0.5

        let combatTier = 'healthy'
        let tierName = '血量和护盾都还够'
        if (!shieldOk && !hpOk) {
          combatTier = 'danger'
          tierName = `破盾且血少（盾${Math.round(shieldRatio * 100)}% 血${Math.round(hpRatio * 100)}%）`
        } else if (!shieldOk || !hpOk) {
          combatTier = 'cautious'
          tierName = !shieldOk
            ? `盾掉了但血还够（盾${Math.round(shieldRatio * 100)}%）`
            : `血少了但还有盾（血${Math.round(hpRatio * 100)}%）`
        }
        // ── 遥测：把判定这一档用的原始数据留下来（只记不判）────────────
        combatStats.frames++
        combatStats.tierFrames[combatTier]++
        if (combatStats.minHp === null || hpNow < combatStats.minHp) combatStats.minHp = hpNow
        if (combatStats.minShield === null || shieldNow < combatStats.minShield) combatStats.minShield = shieldNow
        if (combatStats.minHpRatio === null || hpRatio < combatStats.minHpRatio) combatStats.minHpRatio = hpRatio
        if (combatStats.minShieldRatio === null || shieldRatio < combatStats.minShieldRatio) combatStats.minShieldRatio = shieldRatio
        combatStats.hpBaseline = hpBaseline
        combatStats.shieldBaseline = shieldBaseline
        if (combatStats.lastTier === null) {
          combatStats.lastTier = combatTier
        } else if (combatStats.lastTier !== combatTier) {
          combatStats.tierEntered[combatTier]++
          noteTier(combatStats.lastTier, combatTier, hpNow, shieldNow, hpRatio, shieldRatio, clock.now)
          combatStats.lastTier = combatTier
        }
        // ── 低血模式：不硬顶、不逃跑，只做「少挨打」（2026-10-26 用户纠正后重写）──
        //
        // ⚠️ 先纠正一个我自己写错过的前提：**战斗一开，场景两侧会落下屏障，跑不出去。**
        //    所以这里**不是撤退**，是「在场地里换一种打法」：
        //      · 处决(L) 是唯一能让血条变长的动作 —— 它在上面（executePrompt 分支）
        //        已经全局最高优先级，**不受这段影响**，一出现提示就该按 L
        //      · 没处决提示时：后撤一步 / 闪一下让敌人这刀打空，然后**不追招**
        //      · 湍流(8)/流场(9) 消耗生命，低血时花血换免疫是亏的 —— 低血模式里直接跳过
        //
        // 原来的问题不是「没有撤」，是 danger 档照样 combo/heavy 顶上去，越打越勇直到死。
        const panic = hpBaseline > 0 && shieldBaseline > 0
          && hpNow / hpBaseline < PANIC_HP_RATIO
          && shieldNow / shieldBaseline < PANIC_SHIELD_RATIO
        if (panic && clock.now - lastBackoffAt > BACKOFF_COOLDOWN_MS) {
          lastBackoffAt = clock.now
          const away = facing === 'right' ? 'left' : 'right'
          const hpPct = Math.round((hpNow / hpBaseline) * 100)
          const shPct = Math.round((shieldNow / shieldBaseline) * 100)
          facing = away
          return {
            action: 'dash', dir: away, ms: 220,
            why: `血 ${hpPct}% 盾 ${shPct}% → 低血：闪开这一下、不追招（场地有屏障，退不出去；等处决提示按 L 回血）`,
          }
        }

        // ── 朝向 / 打空 的记账（2026-10-26 新增）─────────────────────
        //
        // 背景：这一段原来写的是「`foeDir !== dir` 就先朝那边挪一步」，把 `dir`（探索方向）
        // 当成朝向来用 —— 这是错的，两回事。而且它还顺手把 `dir` 改成了 foeDir，
        // 于是 foeDir 不变时这个分支再也不会触发。
        //
        // 2026-10-26 真机实测补上的事实：
        //   · 朝向 = **最后一次移动方向**；轻点方向键 60~140ms 就翻面（位移 35~175px）
        //   · U / `chase` **都不转身**（单按 U 只出剑气）
        //   ⇒ 所以转身要用新加的 `face` 动作（只按方向键、不点 U），并且**朝向要自己记**。
        //
        // 第二个信号：「连击数多久没涨」。连击只在**打中**时上涨，所以它不涨 ≈ 在朝空气挥。
        // 这是目前唯一不依赖敌人检测的「打空了」反馈（像素法已实测否决，见 HANDOFF 第六节）。
        // 连击数**只有打中才会上涨**；读不到它（= 没在打、或者 HUD 上暂时没有计数）时，
        // 必须把时钟一起推着走，否则 comboGainAt 会永远停在过去某一刻，
        // 之后每一帧都算「停滞」，人就每 1.2 秒原地翻一次面。
        // 🔴 这不是假设 —— 2026-10-26 首跑实测：60 秒里 face 了 26 次，人一步没往前挪，
        //    日志写着「连击数 42.1s 没涨」。就是这里漏了 else 分支。
        if (typeof m.combo === 'number' && m.combo > 0) {
          if (prevCombo === null || m.combo > prevCombo) {
            prevCombo = m.combo
            comboGainAt = clock.now
          }
        } else {
          prevCombo = null
          comboGainAt = clock.now
        }
        const comboStale = clock.now - comboGainAt >= COMBO_STALE_MS
        // 只有「刚出过招」才值得怀疑打空了；平时站着不动翻面没有意义
        const attackedRecently = clock.now - lastComboAt < COMBO_STALE_MS * 2
        const canFace = clock.now - lastFaceAt >= FACE_COOLDOWN_MS

        // ① 知道敌人在哪边（黄色敌情箭头 / 处决提示）→ 直接朝那边转身，这是最靠谱的情况
        if (foeDir && foeDir !== facing && canFace) {
          const was = facing
          lastFaceAt = clock.now
          facing = foeDir
          return {
            action: 'face', dir: foeDir,
            why: `敌人在${foeDir === 'left' ? '左' : '右'}边、当前朝${was === 'left' ? '左' : '右'} → 转身（轻点方向键；U 不转身）`,
          }
        }
        // ② 不知道敌人在哪边，但连击数已经 1.5 秒没涨 → 大概率朝反了，翻个面试。
        //    代价小（约 35px），翻错也比继续朝空气挥强；限流 1.2 秒，避免原地抽搐。
        if (!foeDir && comboStale && attackedRecently && canFace) {
          const flip = facing === 'right' ? 'left' : 'right'
          lastFaceAt = clock.now
          facing = flip
          return {
            action: 'face', dir: flip,
            why: `连击数 ${((clock.now - comboGainAt) / 1000).toFixed(1)}s 没涨 → 可能在朝空气挥，翻面向${flip === 'left' ? '左' : '右'}试试`,
          }
        }

        // 画面几乎不动 + 刚在挨打 ⇒ 大概率被打倒在地，需要按空格起身
        if (motion < STILL_MOTION * 2 && clock.now - lastGetUpAt > 1000) {
          lastGetUpAt = clock.now
          return { action: 'jump', ms: 140, why: '画面不动又在挨打 → 可能倒地了，按空格起身' }
        }
        // ⚠️ 这里**不能再有按固定周期硬塞的动作**（原来 heavyEvery=2 就是每两次决策强来一次重击，
        //    把战斗权重表压成 heavy 57%、combo 只剩 2% —— 真机 25 秒实测出来的）。
        //    节奏交给下面的权重表；只有「强化技没解锁时按了也没反应」这类试探保留低频周期。
        // ⚠️ 2026-10-26 实测纠正：**U 不是索敌键**。
        //    单按 U 只原地出剑气 —— 不位移、不转身（怪在右边、她朝左时按 U，仍然朝左）。
        //    所以这里每 7 个循环塞一次 chase，**U 那一下本身什么也没干**。
        //
        //    那它是不是纯浪费？不一定 —— 因为 chase 是「按住 dir + 点 U」两步，
        //    **按住方向键那一步会移动，而横版游戏的朝向 = 最后一次移动方向**，
        //    所以转向效果（如果有）来自方向键，不来自 U。
        //    ⇒ 这个注入实际做的是「朝 foeDir 走 260ms + 出一记剑气」。
        //
        //    ⚠️「按住方向键真的会转身」目前还是推断（来自上面那条朝向规则），**没单独验过**。
        //    要验也很便宜：贴着怪、面向反方向，轻点一下反方向键，看角色是否翻面。
        //    验完再决定这个 260ms 该不该缩短 —— 只为了转身的话，80ms 就够，
        //    260ms 在打架里是白白挪出去的距离。（项目的老规矩：没数据先别改数字。）
        if (cycle % 7 === 0) {
          return {
            action: 'chase', dir: foeDir || dir, ms: 260,
            why: foeDir ? `朝${foeDir === 'left' ? '左' : '右'}边挪一步（U 不索敌，转向靠方向键）` : '在打架 → 朝当前方向挪一下（U 不索敌）',
          }
        }
        if (cycle % 23 === 0) return { action: 'dash', dir, ms: 160, why: '在打架（有连击数）→ 闪现取消硬直' }
        // 强化技：湍流(8)/流场(9) **消耗生命**换爆发/免疫，不能太频繁。
        // 权重表里它们各占约 3.7%，这里只做低频兜底（周期 37/41 ≈ 每次 2.5%）。
        // 原来这里还有一条「每 37/41 个循环必放一次特殊技」的定时触发，2026-10-25 去掉：
        // 那是当初不确定这两个技值不值、用来"试试看"的探路逻辑。现在知道它们消耗生命换免疫、
        // 性价比不如连段重击，再定时放就是纯浪费血。只留权重表里那一点点低概率出场。
        // **打完接着续连**（2026-10-26 用户要求）。
        //
        // 连段断了的原因有两个（用户 2026-10-25 说明的机制）：
        //   ① 一段时间没打到敌人
        //   ② 护盾破了之后受击
        // 所以「刚打完一套、敌人还在眼前」的时候，最该做的是**继续下一套**，
        // 而不是切去重击/走位 —— 切走就等于把连段亲手掐断。
        //
        // 900ms 是拿动作间隔估的：插件内部一次决策间隔约 0.69 秒，
        // 留出 200ms 余量确保下一套能在断连之前接上。
        const comboWindow = clock.now - lastComboAt < 900
        if (comboWindow && combatTier !== 'danger') {
          const keys = pickWeighted(COMBO_WEIGHTS, rngSeed++)
          lastComboAt = clock.now
          return { action: 'combo', keys, ms: 120, why: `续连 → 连段 ${keys.toUpperCase().split('').join('→')}（上一套刚打完）` }
        }

        // 按档位选权重表
        const fightTable = combatTier === 'danger'
          ? ACTION_WEIGHTS.fightDanger
          : combatTier === 'cautious'
            ? ACTION_WEIGHTS.fightCautious
            : ACTION_WEIGHTS.fight
        // 低血模式下把「消耗生命」的两个强化技权重清零：
        // 湍流(8)/流场(9) 是花血换免疫，血量本来就见底时这是在拿命换几帧无敌。
        const table = panic ? { ...fightTable, storm: 0, shade: 0 } : fightTable
        const pick = pickWeighted(table, rngSeed++)
        if (pick === 'combo') {
          const keys = pickWeighted(COMBO_WEIGHTS, rngSeed++)
          lastComboAt = clock.now
          return { action: 'combo', keys, ms: 120, why: `打架 → 连段 ${keys.toUpperCase().split('').join('→')}` }
        }
        // wait 只在二档/三档出现：缓一下看清敌人动作，不是站着挨打
        if (pick === 'wait') {
          return { action: 'wait', ms: 260, why: `${tierName} → 缓一下，看清再打` }
        }
        return {
          action: pick, ms: 130,
          why: foeDir
            ? `${tierName} → 朝${foeDir === 'left' ? '左' : '右'}边敌人出招`
            : `${tierName} → 出招`,
        }
      }

      // ③ 平时的节奏：**按权重**决定走/跳/砍/冲刺（行动权重）
      // 朝向记账跟一下：非战斗时走路/冲刺本身就是「最后一次移动方向」。
      // 严格说只有真的走了才会翻面，但脱战后的走动会把朝向带回 dir，
      // 用 dir 做近似比让记账永远停在旧值更靠谱（真正的判定点在战斗分支里）。
      facing = dir
      const w = ACTION_WEIGHTS[resolved] || ACTION_WEIGHTS.advance
      // 探索模式：定期掉头把图扫一遍（找宝箱/彩蛋）
      if (p.flipEvery && cycle - flipAt >= p.flipEvery) {
        flipAt = cycle
        dir = dir === 'right' ? 'left' : 'right'
        return { action: 'move', dir, ms: p.moveMs || 900, why: `探索 → 掉头往${dir === 'left' ? '左' : '右'}扫另一片区域（找宝箱/彩蛋）` }
      }
      // **确认过的宝箱**（同一位置持续 ≥1.5 秒，排除特效）⇒ 走过去开它
      if (m.chestConfirmed) {
        const cx = m.chestX ?? 0.5
        const dxc = cx - 0.5
        if (Math.abs(dxc) > 0.10) {
          return {
            action: 'move', dir: dxc > 0 ? 'right' : 'left', ms: 400,
            why: `确认到宝箱（持续 ${(m.chestAgeMs || 0) / 1000}s，x=${(cx * 100).toFixed(0)}%）→ 过去开它`,
          }
        }
        return { action: 'move', dir: dxc > 0 ? 'right' : 'left', ms: 260, why: '宝箱就在脚下 → 撞上去开它' }
      }

      // 探索模式：**看见**明显的可破坏物才动手（不再盲砍）
      // 可破坏物本身很显眼：小而高饱和、跟周围背景反差大。检测到了就朝它走，走到跟前再打。
      const dCount = m.destructible || 0
      if (dCount > 0 && m.destructibleX !== null && m.destructibleX !== undefined
          && clock.now - lastStrikeAt > 1600) {
        const dx = m.destructibleX - 0.5
        if (Math.abs(dx) > 0.18) {
          return {
            action: 'move', dir: dx > 0 ? 'right' : 'left', ms: 420,
            why: `看到明显的可破坏物（${dCount} 格，x=${(m.destructibleX * 100).toFixed(0)}%）→ 走过去`,
          }
        }
        lastStrikeAt = clock.now
        return { action: 'attack', ms: 150, why: `可破坏物就在跟前（${dCount} 格）→ 打它` }
      }

      // **黄色实心箭头 = 那个方向有敌人**（2026-10-25 用户说明）
      // 注意：这不是白色空心那个「往这走」的路标，是敌情指示。
      // 它出现在视野之外时，敌人还没进画面 —— 所以朝那边走是"去接战"，到了自然有 combo 接手。
      if (m.enemyDir === 'left' || m.enemyDir === 'right') {
        return {
          action: 'move', dir: m.enemyDir, ms: 460,
          why: `黄色箭头指向${m.enemyDir === 'left' ? '左' : '右'} → 那边有敌人，过去接战`,
        }
      }

      // **白色空心箭头 = 往这走**（路标，2026-10-25 用户说明）
      if (m.arrowDir && (m.arrowDir === 'left' || m.arrowDir === 'right')) {
        return {
          action: 'move', dir: m.arrowDir, ms: 460,
          why: `白色空心箭头指向${m.arrowDir === 'left' ? '左' : '右'} → 往这边走`,
        }
      }

      // **隐藏房间**（用户 2026-10-23：宝箱都在隐藏房间里 ⇒ 找宝箱 = 找隐藏房间）
      // 接缝 = 背景里不自然的竖直断裂，是隐藏入口的候选。
      // 策略：先走过去；到跟前试探一下（有些暗门是撞一下就开）。
      if ((m.seam || 0) > 0 && m.seamX !== null && m.seamX !== undefined) {
        const ds = m.seamX - 0.5
        if (Math.abs(ds) > 0.10) {
          return {
            action: 'move', dir: ds > 0 ? 'right' : 'left', ms: 420,
            why: `发现环境接缝（x=${(m.seamX * 100).toFixed(0)}%，强度 ${Math.round(m.seam)}）→ 走过去看看是不是隐藏房间`,
          }
        }
        if (clock.now - lastSeamAt > 2200) {
          lastSeamAt = clock.now
          return {
            action: 'attack', ms: 150,
            why: `贴到接缝位置了（x=${(m.seamX * 100).toFixed(0)}%）→ 打一下试探，隐藏房间的入口可能是暗门`,
          }
        }
      }
      const chosen = pickWeighted(w, rngSeed++)
      if (chosen === 'move' && p.moveMs > 0) return { action: 'move', dir, ms: p.moveMs, why: `往${dir === 'left' ? '左' : '右'}推进` }
      if (chosen === 'jump') return { action: 'jump', ms: 120, why: '按权重：跳一下（也许有高处的宝箱）' }
      if (chosen === 'dash') return { action: 'dash', dir, ms: 160, why: '按权重：冲刺一段' }
      if (chosen === 'heavy') return { action: 'heavy', ms: 140, why: '按权重：重击' }
      if (chosen === 'chase') return { action: 'chase', dir, ms: 240, why: '按权重：朝当前方向挪一下 + 点 U（U 不索敌）' }
      if (chosen === 'storm') return { action: 'storm', ms: 120, why: '按权重：强化技·湍流' }
      if (chosen === 'shade') return { action: 'shade', ms: 120, why: '按权重：强化技·流场' }
      if (chosen === 'execute') return { action: 'execute', ms: 120, why: '按权重：处决' }
      return { action: 'attack', ms: 120, why: '按权重：普攻' }
    },
  }
}

/** 按权重挑一个动作（确定性：同一个 seed 一定给同一个结果） */
export function pickWeighted(weights, seed) {
  const entries = Object.entries(weights || {}).filter(([, v]) => v > 0)
  if (!entries.length) return 'attack'
  const total = entries.reduce((a, [, v]) => a + v, 0)
  // 简单的整数散列，保证确定性且分布够散
  let x = (seed * 1103515245 + 12345) >>> 0
  x = (x ^ (x >>> 13)) >>> 0
  let r = (x % 100000) / 100000 * total
  for (const [name, v] of entries) {
    if (r < v) return name
    r -= v
  }
  return entries[entries.length - 1][0]
}

/**
 * 把战斗档位遥测翻成一行中文。只描述，不下结论 —— 结论由读日志的人（或模型）下。
 *
 * 关键是要能一眼分开三种「一直是健康档」的原因：
 *   · frames = 0                     → 根本没进过战斗分支（不是档位的问题）
 *   · 最低 ratio 一直 ≈ 100%        → 真的没掉血
 *   · 基线明显高于满血实测值(0.69/0.10) → 被污染锚死了
 * 所以原始读数和基线**必须**一起露出来，只给 ratio 等于没说。
 *
 * @param {object} cs createPolicy().combatStats
 * @returns {string}
 */
export function describeCombat(cs) {
  if (!cs || !cs.frames) return '战斗档位：这一轮一次都没判定过战斗（没检测到连击数）'
  const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`)
  const f = cs.tierFrames || {}
  const bits = [`健康 ${f.healthy || 0} / 收敛 ${f.cautious || 0} / 危险 ${f.danger || 0} 帧`]
  bits.push(`最低血 ${pct(cs.minHpRatio)} 最低盾 ${pct(cs.minShieldRatio)}（相对基线）`)
  bits.push(`原始读数最低 血 ${pct(cs.minHp)} 盾 ${pct(cs.minShield)}`)
  bits.push(`基线 血 ${pct(cs.hpBaseline)} 盾 ${pct(cs.shieldBaseline)}`)
  if (cs.baselineClamped) {
    bits.push(`基线曾被夹住 ${cs.baselineClamped} 次（读数顶到物理上限，说明有污染帧）`)
  }
  const head = `战斗档位：${bits.join('；')}`
  const ch = cs.changes || []
  if (!ch.length) return `${head}。全程没换过档。`
  const seq = ch.map((c) => `${c.from}→${c.to}`).join('、')
  return `${head}。换档 ${ch.length} 次：${seq}`
}

/**
 * 一次自主连玩的成绩单。给模型看，所以要短、要有信息量。
 * @param {{seconds:number, preset:string, actions:Record<string,number>, events:string[], frames:number, stopped:string}} run
 */
export function summarizeRun(run) {
  const parts = []
  // 方向必须按实际来 —— 预设描述原来是写死「往右推进」的，dir=left 时日志会骗人。
  const dirWord = run.dir === 'left' ? '，往左' : run.dir === 'right' ? '，往右' : ''
  parts.push(`自主玩了 ${run.seconds.toFixed(1)} 秒（${run.preset}${dirWord}：${(PRESETS[run.preset] || {}).desc || ''}）。`)
  const total = Object.values(run.actions).reduce((a, b) => a + b, 0)
  const top = Object.entries(run.actions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('、')
  parts.push(`动作 ${total} 次：${top || '（没有）'}`)
  if (run.events.length) parts.push(`途中：${run.events.slice(0, 6).join('；')}`)
  if (run.combat) parts.push(describeCombat(run.combat))
  parts.push(`停止原因：${run.stopped}`)
  // frames 可能是数量，也可能是截图数组（play() 返回的是数组）—— 两种都要说对话
  const frameCount = Array.isArray(run.frames) ? run.frames.length : (Number(run.frames) || 0)
  if (frameCount > 0) parts.push(`附 ${frameCount} 张截图（第一张是卡住现场或途中画面）。`)
  return parts.join('\n')
}

/* ==================== 环境感知（可破坏物 / 隐藏房间线索） ==================== */

/**
 * 把画面切成网格，找两样东西：
 *   ① destructible：**明显**的可破坏物（小而高饱和、跟邻居亮度反差大）
 *   ② seam：背景里不自然的竖直接缝（疑似隐藏房间的入口/暗门）
 *
 * 纯函数，不碰 IO —— selfcheck 用合成帧就能验证。
 *
 * @returns {{destructible:number, destructibleX:number|null, seam:number, seamX:number|null}}
 *   destructible 是命中的格子数；destructibleX 是最强那格的横向比例（0~1）
 *   seam 是接缝强度（0~255），seamX 是接缝所在列的比例
 */
export function analyzeEnvironment(rgba, width, height) {
  const n = width * height * 4
  if (!rgba || rgba.length < n) return { destructible: 0, destructibleX: null, seam: 0, seamX: null }

  const cw = Math.max(1, Math.floor(width / GRID_COLS))
  const ch = Math.max(1, Math.floor(height / GRID_ROWS))
  const lum = new Float32Array(GRID_COLS * GRID_ROWS)
  const sat = new Float32Array(GRID_COLS * GRID_ROWS)
  const blue = new Float32Array(GRID_COLS * GRID_ROWS)
  const cyan = new Float32Array(GRID_COLS * GRID_ROWS)
  const dark = new Float32Array(GRID_COLS * GRID_ROWS)

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      let sumL = 0, sumS = 0, sumB = 0, cnt = 0, cyanN = 0, darkN = 0
      const x0 = gx * cw, x1 = Math.min(width, x0 + cw)
      const y0 = gy * ch, y1 = Math.min(height, y0 + ch)
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
          sumL += r * 0.299 + g * 0.587 + b * 0.114
          sumS += mx ? (mx - mn) / mx : 0
          sumB += b - Math.max(r, g)          // 偏蓝程度
          // 宝箱的真实特征：**青色线条 + 近黑面板**（实测值见文件顶部常量注释）
          if (b > 140 && g > 120 && r < 130 && b - r > 60) cyanN++
          if (sumL >= 0 && (r * 0.299 + g * 0.587 + b * 0.114) < 55) darkN++
          cnt++
        }
      }
      const k = gy * GRID_COLS + gx
      lum[k] = cnt ? sumL / cnt : 0
      sat[k] = cnt ? sumS / cnt : 0
      blue[k] = cnt ? sumB / cnt : 0
      cyan[k] = cnt ? cyanN / cnt : 0
      dark[k] = cnt ? darkN / cnt : 0
    }
  }

  // ① **宝箱**：灰度模板匹配（真实样本校准，误报率 0%）
  //    宝箱是固定美术资源（深色面板 + 青色边框 + 大号青色 $），模板匹配比颜色阈值稳得多。
  //    实测：真宝箱 ZNCC=0.864，92 张负样本最高仅 0.52 ⇒ 阈值 0.62 有很宽的余量。
  const m = matchChest(rgba, width, height)
  const hit = m.score >= CHEST_MATCH_MIN
  let hits = hit ? 6 : 0
  let bestX = hit ? m.x : null
  let chestKind = hit ? (m.kind || 'panel') : null

  // 透明宝箱：箱体半透明，只在暗处浮一个青色 ¥ 符号（隐藏房间里常见）。
  // 背景满屏青色线条时模板匹配分不开，所以用连通块形状判据（见 findTransparentChest）。
  const ghost = findTransparentChest(rgba, width, height)
  if (ghost.hit && !hit) {
    hits = 4
    bestX = ghost.x
    chestKind = 'ghost'
  }
  // ② 接缝：逐列算平均亮度，找「比左右邻列中位数突兀」的列
  const colLum = new Float32Array(GRID_COLS)
  for (let gx = 0; gx < GRID_COLS; gx++) {
    let s = 0, c = 0
    for (let gy = Math.floor(GRID_ROWS * 0.2); gy < GRID_ROWS; gy++) { s += lum[gy * GRID_COLS + gx]; c++ }
    colLum[gx] = c ? s / c : 0
  }
  let seam = 0
  let seamX = null
  for (let gx = 2; gx < GRID_COLS - 2; gx++) {
    const around = [colLum[gx - 2], colLum[gx - 1], colLum[gx + 1], colLum[gx + 2]].sort((a, b) => a - b)
    const med = (around[1] + around[2]) / 2
    const diff = Math.abs(colLum[gx] - med)
    if (diff > seam) { seam = diff; seamX = (gx + 0.5) / GRID_COLS }
  }

  // ===== 菜单结构特征（识别强化/暂停等在菜单里停住的画面）=====
  // 强化页面：整体被压暗 + 左侧一列整齐文字行 + 右侧带边框的演示窗（长横线）。
  // ⚠️ 这个判据**不需要很准**：识别成菜单后的动作是「按 Esc」（在游戏里只是开暂停菜单，
  //    再按一次就关），代价极低；而它要防的是「在升级页误按 Enter 花钱」。
  //
  // 顺手在同一趟扫描里算「隐藏房间指纹」（见下面 gridRoom），不额外多扫一遍。
  let darkN = 0, totN = 0
  let lowSatBrightN = 0, cyanWideN = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const L = r * 0.299 + g * 0.587 + b * 0.114
      if (L < 45) darkN++
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const s = mx ? (mx - mn) / mx : 0
      const v = mx / 255
      if (s < 0.15 && v > 0.72) lowSatBrightN++
      if (s > 0.55 && v > 0.60) cyanWideN++
      totN++
    }
  }
  const darkRatio = totN ? darkN / totN : 0

  /**
   * 隐藏房间指纹（2026-10-24 用两张真实截图量的）。
   *
   * 这种房间：满屏青色网格 + 漂浮三角 + 悬浮的青色「$ / 金币」宝箱。
   * 实测两张图：
   *   低饱和高亮（接近白/灰的亮像素） 0.35% / 0.42%  —— 极少，因为整屏都是青色
   *   高饱和亮青（网格/光带/三角）     6.78% / 7.03%  —— 铺得很开
   *
   * 为什么要这个标志：这个房间里的宝箱**时灵时不灵**。
   *   图 B 能命中（透明宝箱 162x254, aspect 0.64, fill 0.44）
   *   图 A 命中不到 —— 符号被粗光带压过打白，整体退出青色掩码。
   *   试过放宽青色 / 亮白掩码，都失败（背景一起进来，全图连通成一片）。
   * 所以不追求单帧认出来：**先认出房间**，再在房间里靠行为（多走几趟、多打几下）拿到它。
   */
  const lowSatRatio = totN ? lowSatBrightN / totN : 0
  const cyanRatio = totN ? cyanWideN / totN : 0
  const gridRoom = lowSatRatio < GRID_ROOM_LOW_SAT_MAX && cyanRatio > GRID_ROOM_CYAN_MIN

  // 左侧（x 18%~42%）按行统计亮像素，数出文字行
  const lx0 = Math.floor(width * 0.18), lx1 = Math.floor(width * 0.42)
  let listBands = 0
  let inBand = false
  for (let y = 0; y < height; y++) {
    let c = 0
    for (let x = lx0; x < lx1; x++) {
      const i = (y * width + x) * 4
      if (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 > 120) c++
    }
    const on = lx1 > lx0 && c / (lx1 - lx0) > 0.06
    if (on && !inBand) { listBands++; inBand = true } else if (!on) inBand = false
  }

  // 长横亮线（演示窗上下边框那种）
  let longLines = 0
  let inLine = false
  for (let y = 0; y < height; y++) {
    let c = 0
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      if (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 > 110) c++
    }
    const on = (c * 2) / width > 0.22
    if (on && !inLine) { longLines++; inLine = true } else if (!on) inLine = false
  }

  // ===== 战斗屏障（2026-10-24 用户说明的机制）=====
  // 战斗时场景**两端**会升起竖直能量墙，只有把敌人清光才消失。
  // 为什么值得单独检测：它是「这场仗还没打完」最硬的证据，比 HUD 跳动可靠得多。
  // 敌人倒地不动、HUD 不跳的时候 fighting 会变 false，于是插件以为打完、
  // 开始往前走 → 撞上屏障 → 判「这条路走不通」→ 掉头 —— 全程都错了。
  // 判据：左右边缘那两列网格明显比画面中间亮（一道竖直亮墙横跨大半个屏幕高）。
  let edgeL = 0, edgeR = 0, midL = 0, barN = 0
  {
    const by0 = Math.floor(GRID_ROWS * 0.2), by1 = Math.ceil(GRID_ROWS * 0.85)
    for (let gy = by0; gy < by1; gy++) {
      const row = gy * GRID_COLS
      edgeL += lum[row] + lum[row + 1]
      edgeR += lum[row + GRID_COLS - 1] + lum[row + GRID_COLS - 2]
      midL += lum[row + (GRID_COLS >> 1)]
      barN++
    }
  }
  if (barN > 0) { edgeL /= barN * 2; edgeR /= barN * 2; midL /= barN }
  const BARRIER_MIN = 85      // 屏障本身得够亮（青白发光）
  const BARRIER_RATIO = 1.6   // 还得比中间亮出一截，避免把普通亮背景当屏障
  const barrierLeft = edgeL > BARRIER_MIN && edgeL > midL * BARRIER_RATIO
  const barrierRight = edgeR > BARRIER_MIN && edgeR > midL * BARRIER_RATIO

  return {
    darkRatio: +darkRatio.toFixed(3),
    listBands,
    longLines,
    // 战斗屏障：横跨屏幕两端时说明这场仗还没打完（见上面那段注释）
    barrier: barrierLeft || barrierRight,
    barrierLeft,
    barrierRight,
    barrierEdge: +Math.max(edgeL, edgeR).toFixed(1),
    // 隐藏房间指纹：看这个就知道「我是不是在那个满屏青色网格的房间里」
    gridRoom,
    lowSatRatio: +lowSatRatio.toFixed(4),
    cyanRatio: +cyanRatio.toFixed(4),
    // 兼容旧字段名（策略里读的是 destructible，现在含义 = 宝箱候选）
    destructible: hits,
    destructibleX: bestX,
    chest: hits,
    chestX: bestX,
    chestScore: m.score,
    chestKind,
    seam: seam >= SEAM_DIFF ? seam : 0,
    seamX: seam >= SEAM_DIFF ? seamX : null,
  }
}
/* ==================== 宝箱：靠「持续性」确认 ==================== */

/**
 * 宝箱追踪器（有状态，但只依赖喂进来的输入，可离线单测）
 *
 * 为什么不再用「金色」判据（用户 2026-10-23 纠正）：
 *   宝箱**整体是蓝的，连中间的钱符号也是蓝的**，没有金色。
 *   而场景里蓝色东西太多（天空、水面、剑光、技能特效），单帧颜色根本分不开。
 *
 * 所以改成**时间维度**确认：同一个横向位置连续出现蓝色小块 ≥ minMs 才算真宝箱。
 * 技能特效一闪而过（通常 < 1 秒），静态宝箱会一直待在那儿。
 *
 * @param {{minMs?:number, driftX?:number, forgetMs?:number}} [opts]
 */
export function createChestTracker(opts = {}) {
  const minMs = opts.minMs ?? 1500          // 持续多久算确认
  const driftX = opts.driftX ?? 0.06        // 允许的横向漂移（角色走动会让物体移动）
  const forgetMs = opts.forgetMs ?? 1200     // 多久没再看到就丢弃

  let track = null

  return {
    /** 每帧喂一次；返回确认到的宝箱（没有就 null） */
    feed(env, now) {
      const count = env?.chest || 0
      const x = env?.chestX
      if (count < 2 || x === null || x === undefined) {
        if (track && now - track.lastSeen > forgetMs) track = null
        return null
      }
      if (track && Math.abs(x - track.x) <= driftX) {
        track.x = track.x * 0.7 + x * 0.3   // 平滑跟随
        track.lastSeen = now
        track.age += 1
      } else {
        track = { x, firstSeen: now, lastSeen: now, age: 1 }
      }
      if (now - track.firstSeen >= minMs) {
        return { x: track.x, age: track.age, sinceMs: now - track.firstSeen }
      }
      return null
    },
    get state() { return track },
    reset() { track = null },
  }
}
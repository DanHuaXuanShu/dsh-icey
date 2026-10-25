import { matchChest, findTransparentChest } from './ui/chest-match.mjs'
import { regionStats, globalBrightRatio, frameDiffRatio } from './ui/scan.mjs'
import {
  HUD_BOX, HUD_LUM_MIN, HUD_Y_STEP, HUD_X_STEP,
  PROMPT_BOX, PROMPT_LUM_MIN,
  SUBTITLE_BOX, SUBTITLE_LUM_MIN, SUBTITLE_MIN,
  VFX_LUM_MIN, VFX_DANGER,
  MENU_LIST_BANDS, MENU_DARK_RATIO,
} from './games/icey/layout.mjs'

/**
 * 这几个常量现在住在 lib/games/icey/layout.mjs（画面布局与阈值），
 * 这里转出去，保持老引用（selfcheck 等）不用改。
 */
export { HUD_BOX, PROMPT_BOX, SUBTITLE_BOX, SUBTITLE_MIN, VFX_DANGER, MENU_LIST_BANDS, MENU_DARK_RATIO }

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

  if (!prev || prev.width !== width || prev.height !== height) {
    return { ok: true, width, height, hud, hudBright, promptBright, subtitle, vfx, motion: null, hudKick: null }
  }

  const motion = frameDiffRatio(rgba, prev.rgba, 12)
  const hudKick = Math.abs(hud - (prev.hud ?? hud)) / 255

  return { ok: true, width, height, hud, hudBright, promptBright, subtitle, vfx, motion, hudKick }
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
  fight: { combo: 10, heavy: 6, attack: 5, chase: 1, dash: 1, storm: 1, shade: 1 },
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
export const FIGHT_WINDOW = 8           // 滑动窗口长度（次决策）
export const FIGHT_ACTIVE_RATIO = 0.4   // 窗口里 ≥40% 活跃 ⇒ 判定在战斗
export const FIGHT_HOLD_MS = 2500       // 开打后粘滞这么久（战斗有间歇，别抖）
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
  let dialogueInteracts = 0     // 旁白/对话里按确认键的次数（不受菜单那 3 次限制）
  let subtitleStreak = 0
  let lastSubtitleAt = -Infinity
  let flipAt = 0
  let menuEscCount = 0
  let lastMenuEscAt = -Infinity
  let lastExecuteAt = -Infinity
  let hpBaseline = 0
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

    /**
     * @param {{motion:number|null, hudKick:number|null}} m 画面指标
     * @param {{now:number}} [clock] 时间（毫秒，外部传入便于测试）
     * @returns {{action:string, dir?:string, ms?:number, why:string}}
     */
    decide(m, clock = { now: 0 }) {
      const motion = m.motion ?? 1
      const hudKick = m.hudKick ?? 0
      const bright = m.hudBright ?? 1
      // **战斗检测**：不能靠敌人血条（用户 2026-10-24：大部分怪没有血条）。
      //
      // 🔴 hudKick 不能参与战斗判断（2026-10-25 复查代码时发现原判据是错的）：
      //   hudKick = |HUD 区域平均亮度 - 上一帧| / 255，是个 0~1 的比例。
      //   战斗帧里它的中位数只有 0.17%（= 0.0017），而 FIGHT_HUDKICK = 0.02（= 2%），
      //   差 12 倍 —— 战斗永远够不着这个阈值。
      //   它真正会跳起来的场合是菜单开合、场景切换、过场 —— 那是 **UI 切换**，不是战斗。
      //   所以把它留在判据里只会制造假阳性：
      //   「第 1s 进入战斗（HUD 在跳）」那次的真相就是暂停菜单刚关上。
      //
      // 可靠信号是**画面活跃度**：连拍实测（连续帧、100ms 间隔）
      //   战斗中 motion 中位 24.6%（刀光/敌人动作/伤害数字满天飞）
      //   空地上 motion 中位  0.7%（角色站着，画面几乎不动）—— 差 34 倍
      //   2026-10-25 复核：空地与强化台旁各 40 帧等间隔连拍，
      //   motion 中位分别是 1.20% / 1.31%，与上面的空地值同量级，阈值 8% 留得住。
      // 单帧高 motion 也可能是「刚放了一招」，所以看**最近 8 次里高活跃的比例**。
      motionWindow.push(motion)
      if (motionWindow.length > FIGHT_WINDOW) motionWindow.shift()
      const activeN = motionWindow.reduce((a, v) => a + (v >= FIGHT_MOTION ? 1 : 0), 0)
      const activeRatio = activeN / motionWindow.length
      // 战斗屏障也算「还在打」：屏障只在敌人清光后消失，
      // 所以它开着就证明这场仗没结束（2026-10-24 用户说明的机制）。
      // 补的正是「敌人倒地不动、画面安静」那种空档 —— 那时只有屏障还亮着。
      const fightingNow = activeRatio >= FIGHT_ACTIVE_RATIO
        || m.barrier === true
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

      // ⓪c **停在菜单里**（强化页面/暂停/系统界面）：
      //     这些界面右侧常有「招式演示动画」一直在动，会被误当成游戏在跑；
      //     更危险的是强化页里按 Enter = 「升级」会花掉 $。
      //     ⇒ 判定为菜单时只按 Esc，并且**绝不按 Enter**。
      const listBands = m.listBands ?? 0
      const darkRatio = m.darkRatio ?? 0
      if (listBands >= MENU_LIST_BANDS || darkRatio > MENU_DARK_RATIO) {
        stillStreak = 0
        if (clock.now - lastMenuEscAt > 1400) {
          lastMenuEscAt = clock.now
          menuEscCount++
          return {
            action: 'pause', ms: 110,
            why: `看起来停在菜单（左侧 ${listBands} 行文字 / 压暗 ${(darkRatio * 100).toFixed(0)}%）→ 按 Esc 退出（第 ${menuEscCount} 次）`,
          }
        }
        return { action: 'wait', ms: 300, why: '等菜单关闭' }
      }
      menuEscCount = 0

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
        // 血量/护盾基线：用来判断「是不是在掉血」
        const hpNow = m.hudBright || 0
        if (hpNow > hpBaseline) hpBaseline = hpNow
        // 掉到基线的 72% 以下 ⇒ 正在挨打/护盾快破 ⇒ **先撤**，别硬吃（破盾后受击会倒地）
        if (hpBaseline > 0 && hpNow < hpBaseline * 0.72 && clock.now - lastDodgeAt > 1200) {
          lastDodgeAt = clock.now
          return {
            action: 'dash', dir: dir === 'right' ? 'left' : 'right', ms: 220,
            why: `护盾/血量在掉（${(hpNow * 100).toFixed(1)}% < 基线 ${(hpBaseline * 100).toFixed(1)}% 的 72%）→ 先闪开，避免破盾`,
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
        if (cycle % 29 === 0) return { action: 'chase', dir, ms: 260, why: '在打架 → 追击拉近距离（U）' }
        if (cycle % 23 === 0) return { action: 'dash', dir, ms: 160, why: 'HUD 在跳 → 闪现取消硬直' }
        // 强化技：湍流(8)/流场(9) **消耗生命**换爆发/免疫，不能太频繁。
        // 权重表里它们各占约 3.7%，这里只做低频兜底（周期 37/41 ≈ 每次 2.5%）。
        if (cycle % 37 === 0) return { action: 'storm', ms: 120, why: '打架 → 试试强化技·湍流（键 8，消耗生命换免疫）' }
        if (cycle % 41 === 0) return { action: 'shade', ms: 120, why: '打架 → 试试强化技·流场（键 9，消耗生命换免疫）' }
        // 打架时统一用「战斗权重」；抽到 combo 就按 COMBO_WEIGHTS 挑一套
        const pick = pickWeighted(ACTION_WEIGHTS.fight, rngSeed++)
        if (pick === 'combo') {
          const keys = pickWeighted(COMBO_WEIGHTS, rngSeed++)
          return { action: 'combo', keys, ms: 120, why: `打架 → 连段 ${keys.toUpperCase().split('').join('→')}` }
        }
        return { action: pick, ms: 130, why: 'HUD 在跳（在打架）→ 按战斗权重出招' }
      }

      // ③ 平时的节奏：**按权重**决定走/跳/砍/冲刺（行动权重）
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

      // **跟着画面里的箭头走**（游戏自己给的指引，最可信的方向信号之一）
      if (m.arrowDir && (m.arrowDir === 'left' || m.arrowDir === 'right')) {
        return {
          action: 'move', dir: m.arrowDir, ms: 460,
          why: `画面箭头指向${m.arrowDir === 'left' ? '左' : '右'} → 跟着它走`,
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
      if (chosen === 'move' && p.moveMs > 0) return { action: 'move', dir, ms: p.moveMs, why: `往${dir === 'right' ? '右' : dir}推进` }
      if (chosen === 'jump') return { action: 'jump', ms: 120, why: '按权重：跳一下（也许有高处的宝箱）' }
      if (chosen === 'dash') return { action: 'dash', dir, ms: 160, why: '按权重：冲刺一段' }
      if (chosen === 'heavy') return { action: 'heavy', ms: 140, why: '按权重：重击' }
      if (chosen === 'chase') return { action: 'chase', dir, ms: 240, why: '按权重：追击' }
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
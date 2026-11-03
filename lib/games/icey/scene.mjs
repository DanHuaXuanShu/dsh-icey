/**
 * lib/games/icey/scene.mjs —— 把「一帧的特征」归纳成「当前是哪一种场景」
 *
 * 为什么需要这一层：
 *   以前 decide() 直接从原始特征里做判断（`if (combo) 打` `if (menuRows) 退`），
 *   每个分支各看各的，没有一个地方回答「现在到底处在什么状态」。
 *   后果是遇到**没有对应分支**的局面（剧情锁、商店、需要解谜的门），
 *   它只会掉进默认的「继续往右走」，然后一次次撞同一面墙 ——
 *   2026-10-25 实测三轮同一间屋子 move×67 / move×69 / move×83 就是这么来的。
 *
 * 这一层只做归纳，不做决策：输出一个标签 + 为什么是它。
 * decide() 按标签分派，遇到 `stuck` 就停下手报告，而不是继续撞。
 *
 * 参考了外面几个项目的思路（2026-10-26 用户提供）：
 *   - Claude Plays Pokemon：靠 LLM 逐帧读画面，慢但能理解
 *   - Black Myth Wukong AI：DQN 靠海量试错，换游戏得重练
 *   - YOLOv8-Overlay-CS2：专用小模型做实时感知，快但只会一件事
 * 我们取第三条的一半：**用轻量特征做实时场景归类**，把「理解」留给 LLM。
 * 区别是不训模型 —— 这些类别用现有特征就分得开，训模型反而没数据、没好处。
 */

import { COMBO_MIN, MENU_RED_ROWS, MENU_HUD_BRIGHT_MAX } from './layout.mjs'

/** 旁白/字幕出现到多少算「在说话」。跟 layout 里的 SUBTITLE_MIN 保持一致。 */
export const SCENE_SUBTITLE_MIN = 0.004

/** 黑屏阈值：HUD 区几乎全暗 = 过场/加载/标题。 */
export const SCENE_BLANK_HUD = 0.01

/* ==================== 死亡菜单（「再次作战 / 重新开始」） ==================== */

/**
 * 为什么这一组常量写在本文件、不写进 layout.mjs：
 *   它们是**场景归类**的判据，不是画面布局的坐标常量；layout.mjs 管的是「框在哪、亮度门限多少」。
 *   而且 task-5 的改动还没提交，本任务不碰那个文件。
 *
 * 判据由三件事一起成立（缺一条都不行，见 classifyScene 里的注释）：
 *   1. HUD 区没有亮像素 —— 血条/护盾/连击全没了（`deathHud`）
 *   2. 画面大面积暖色（暗红棕底色）—— `deathWarm`
 *   3. 中部有 ≥2 行成行的白字（「再次作战」「重新开始」）—— `deathRows`
 *
 * 实测（2026-11-03，shots/ 全量 4526 帧，32 个目录）：
 *   · 40 帧真死亡菜单：warm 66.39%–88.47%，rows 2–3（39 帧 2 行、1 帧 3 行），
 *     hudBright 全部为 0
 *   · 最高 warm 的负样本 w0448 也有 81.59% —— **单看颜色一定误报**，
 *     它靠 rows=0（只有底色、没有那两行字）被排除
 *   · ⚠️ warm 单独看根本没有余量：`shots/timeline/f01021.png` 是死亡菜单的**底色过渡帧**
 *     （暗红棕横条纹，字还没画出来），warm 99.87% —— 比任何一帧真死亡菜单都高。
 *     它同样靠 rows=0 被排除。所以「暖色」不是判据，只是排掉黑屏/蓝绿场景的粗筛；
 *     真正把死亡菜单从同色过渡帧里挑出来的是那两行字。
 *
 * 那 25% 这条线到底在挡什么：`hudBright<0.01 && rows>=2 && warm<25%` 的负样本有 12 帧
 *   （shots/skills/pair-02..07 技能说明面板 5 帧、timeline/f00301–306 元叙事「说明.txt」
 *   控制台 6 帧、ui-neg/t1032 1 帧）。它们 hud 没了、rows 还有 4–8 行，只能靠 warm 挡。
 *   实测门槛在 0.25~0.66 之间任取，命中都是 40/40、误报 0 —— 安全窗口很宽，
 *   但 0.25 贴在窗口**下沿**（最高负样本 24.76%，只高 0.24 个百分点）。
 *   这是**故意的**，不是调歪了：往下漏一帧死亡菜单，就重现了本任务要修的那个 bug
 *   （对着死亡菜单空按到超时）；往上误判一帧非死亡画面，代价只是停手交回模型。
 *   所以这条线偏向召回，取窗口下沿。
 */
export const DEATH_WARM_MIN = 0.25
export const DEATH_ROWS_MIN = 2
export const DEATH_HUD_MAX = 0.01

/** 暖色判定：R 比 B 高出这个量才算「暗红棕」。纯灰/纯黑不算。 */
export const DEATH_RB_GAP = 12

/** 扫「底色暖不暖」的范围：避开四周边缘，取中间那块游戏画面。 */
export const DEATH_CONTENT_BOX = { x0: 0.10, y0: 0.05, x1: 0.90, y1: 0.97 }

/** 扫「选项文字行」的范围：两条选项落在画面下半部的中间一带。 */
export const DEATH_OPT_BOX = { x0: 0.15, y0: 0.42, x1: 0.85, y1: 0.82 }

/**
 * 把 hud 的两种单位都收成 0~1 比例。
 *
 * 🔴 2026-10-26 修：`analyzeFrame` 给的 `hud` 是**平均亮度 0~255**（autoplay.mjs 里 hudKick
 *    还要再 /255 才成立，反证了它是 0~255），而本文件的门限历来按 0~1 比例写 ⇒ 差 255 倍：
 *    · blank 判据 `hud < 0.01` 在正常帧上永不成立（正常帧是几十）；
 *    · `StuckDetector` 的 `|Δhud| > 0.05` 几乎每帧都成立 ⇒ 45 秒无进展永远攒不满。
 *    所以「>1 就当它是 0~255」，两种调用方都不必改。selfcheck 里喂 0.5 那种比例的断言照样成立。
 */
export function hudRatio(hud) {
  const v = typeof hud === 'number' && Number.isFinite(hud) ? hud : 0
  return v > 1 ? v / 255 : v
}

/**
 * 卡住判定：连续多久没有任何「进展信号」就算卡住。
 * 45 秒是拿实测数据定的 —— 正常一次战斗或一次场景切换远不到这个数，
 * 而撞墙时 move×83 是 83 次动作 × 0.69s ≈ 57 秒，中间没有任何进展。
 */
export const STUCK_MS = 45000

/**
 * 判定一帧属于哪种场景。
 *
 * @param {object} m analyzeFrame() 的返回值
 * @returns {{ scene: string, why: string }}
 *   scene 取值：
 *     'menu'     —— 暂停菜单（有红色警告文字行）
 *     'death'    —— 死亡菜单（「再次作战 / 重新开始」）：无 HUD + 暗红棕底 + 两行白色选项
 *     'combat'   —— 战斗中（连击数在涨 / 战斗屏障在 / 刚掉血）
 *     'dialog'   —— 旁白或对话在说话（下方白字）
 *     'blank'    —— 黑屏（过场动画、加载、标题画面）
 *     'stuck'    —— 卡住了（外部传入的卡住标记，见 StuckDetector）
 *     'explore'  —— 其余：有 HUD、没在打、没人说话 ⇒ 可以正常推进
 */
export function classifyScene(m, opts = {}) {
  const { stuck = false } = opts

  // 顺序有讲究：
  // 菜单排第一 —— 菜单盖住一切，其它特征都不作数。
  //
  // 🔴 2026-11-03 加第二条闸「HUD 已经压暗」：原来只要求红字行 ≥1，单看这一条
  //    在 640 宽下会把战斗帧判成菜单。实测（`shots/combat` 593 帧，用 classifyScene 判）：
  //      480 宽 → 误判 0 帧；640 宽 → 误判 5 帧。
  //    因为 640 保留的细节更多，战斗里零散的红字（伤害数字、霓虹窗）更容易凑成一行，
  //    而真正的暂停/设置菜单有个共同点：**HUD 被整屏压暗**。
  //    实测真菜单 `hudBright` 是 0.0%~0.2%，而误判的 c0075 / c0330 / c0584 分别是
  //    5.3% / 3.9% / 1.5% —— HUD 还亮着，那是战斗帧。
  //    加这条闸之后 640 下的误判从 5 帧降到 2 帧（c0588 0.55% / c0593 0%，HUD 已灭，
  //    与真菜单不可区分，按 Esc 也无害）。
  //    ⚠️ 别把这条闸调得更松：它的作用就是「HUD 还亮就别认成菜单」。
  if ((m.menuRows ?? 0) >= MENU_RED_ROWS && (m.hudBright ?? 0) <= MENU_HUD_BRIGHT_MAX) {
    return { scene: 'menu', why: `菜单里有 ${m.menuRows} 条红色警告文字行（HUD 已压暗 ${((m.hudBright ?? 0) * 100).toFixed(1)}%）` }
  }

  // 死亡菜单排在菜单之后、战斗之前。
  //
  // 为什么不靠 `upgradeMenu` 把死亡菜单排除掉：实测 `upgradeMenu`（dark>=0.78 && demo>=90）
  //   在 40 张真死亡帧上命中 **18 张**（dark 0.78–0.93、demo 72.9–98.59）——
  //   两者在像素层面确实重叠，重叠是真的，不是假想的。
  //   但**顺序本身把这件事解决了**：死亡分支在前面，被认成 death 的帧根本走不到
  //   decide() 里那条 `if (m.upgradeMenu)` 分支（autoplay.mjs:1200）。
  //   而那条分支按的是 Esc（只关闭、不选中任何项），就算真漏进来也不会花钱。
  //   所以这里不需要再加一条「排除 upgradeMenu」的判据。
  //   🔴 原注释写「命中 0 张，那条路是在修一个不存在的重叠」—— 2026-11-03 实测推翻。
  //      这个错误方向很危险：若照着「两者不重叠」去排分支，会让死亡帧有机会落进
  //      upgradeMenu 分支，而升级页面上的 Enter 是花钱的。
  //
  // 为什么必须排在 dialog 之前：死亡菜单的两行选项落在 y≈0.57~0.71，
  //   正好压进 SUBTITLE_BOX（0.689~0.948）的下沿，会被认成「有人在说话」；
  //   按 dialog 处理就会去按确认跳对话，而在死亡菜单上确认 = 选「再次作战」。
  //
  // 三个条件缺一不可（实测：单看暖色会误报，w0448 的 warm 有 81.6% 却没这两行字）：
  //
  // ⚠️ 「无 HUD」这一条必须用 hudBright（HUD 框内**亮像素占比**），不能用 hud。
  //   实测死亡菜单 hud = 22.57–32.22（暗红棕底本身有亮度，换算 0~1 是 9%~13%），而 hudBright = 0。
  //   拿 hud 去判「HUD 没了」会漏掉**全部 40 张**真死亡帧（实测命中 0/40）——
  //   这正是它当初一路掉进 blank/explore 的原因。手搓的 m 没有 hudBright 时才退回 hudRatio。
  const hudLight = typeof m.hudBright === 'number' ? m.hudBright : hudRatio(m.hud ?? 0)
  if (
    hudLight < DEATH_HUD_MAX
    && (m.deathRows ?? 0) >= DEATH_ROWS_MIN
    && (m.deathWarm ?? 0) >= DEATH_WARM_MIN
  ) {
    return {
      scene: 'death',
      why: `死亡菜单：无 HUD + 暗红棕底色 ${((m.deathWarm ?? 0) * 100).toFixed(1)}% + ${m.deathRows} 行白色选项（再次作战 / 重新开始）`,
    }
  }

  // 战斗排在旁白前面：打架时也可能有字幕（剧情战），但这时候该打不该读字。
  if ((m.combo ?? 0) >= COMBO_MIN) {
    return { scene: 'combat', why: `连击数在涨（${((m.combo ?? 0) * 100).toFixed(2)}%）` }
  }
  if (m.barrier === true) {
    return { scene: 'combat', why: '战斗屏障还亮着（敌人没清完）' }
  }

  if ((m.subtitle ?? 0) >= SCENE_SUBTITLE_MIN) {
    return { scene: 'dialog', why: `下方白字 ${((m.subtitle ?? 0) * 100).toFixed(1)}% → 有人在说话` }
  }

  // 黑屏：HUD 区几乎全暗。注意要在 dialog 之后判断 ——
  // 过场里「黑屏 + 字幕」很常见，那种情况按 dialog 处理（该按确认跳过）更合适。
  if (hudRatio(m.hud ?? 0) < SCENE_BLANK_HUD) {
    return { scene: 'blank', why: `HUD 区几乎没有亮像素（${(hudRatio(m.hud ?? 0) * 100).toFixed(2)}%）` }
  }

  if (stuck) {
    return { scene: 'stuck', why: `已经 ${Math.round((opts.stuckMs ?? 0) / 1000)} 秒没有任何进展信号` }
  }

  return { scene: 'explore', why: '有 HUD、没在打、没人说话 → 可以推进' }
}

/**
 * 卡住检测器：跟踪「最后一次进展」是什么时候。
 *
 * 什么叫进展（任何一条都算）：
 *   - 进入过战斗（combo 出现过）
 *   - 场景切换（画面剧变）
 *   - 旁白变了（字幕出现/消失）
 *   - HUD 结构变了（血条长度、提示区亮度明显变化）
 *
 * 不把「角色在走」算进展 —— 撞墙时角色也一直在走，那正是要识别的状态。
 */
export class StuckDetector {
  constructor({ stuckMs = STUCK_MS } = {}) {
    this.stuckMs = stuckMs
    this.lastProgressAt = 0
    this.lastScene = null
    this.lastSubtitle = 0
    this.lastHud = 0
    this.progressCount = 0
  }

  /** 调用方每帧喂一次，返回是否已经卡住。 */
  update(scene, m, now) {
    if (this.lastProgressAt === 0) this.lastProgressAt = now

    const subtitle = m.subtitle ?? 0
    const hud = hudRatio(m.hud ?? 0)

    let progressed = false

    // 1. 场景标签变了（explore → combat、combat → dialog 之类）
    if (this.lastScene !== null && scene !== this.lastScene) progressed = true

    // 2. 字幕明显变化（说话内容换了，或开始/结束说话）
    if (Math.abs(subtitle - this.lastSubtitle) > 0.004) progressed = true

    // 3. HUD 明显变化（血条长度、提示区亮度）—— 阈值要宽，否则镜头微动也算
    if (Math.abs(hud - this.lastHud) > 0.05) progressed = true

    if (progressed) {
      this.lastProgressAt = now
      this.progressCount++
    }

    this.lastScene = scene
    this.lastSubtitle = subtitle
    this.lastHud = hud

    return now - this.lastProgressAt > this.stuckMs
  }

  /** 外部主动上报进展（比如刚打了一场、刚穿过一道门）。 */
  markProgress(now) {
    this.lastProgressAt = now
    this.progressCount++
  }

  stuckMsNow(now) {
    return now - this.lastProgressAt
  }

  reset(now) {
    this.lastProgressAt = now
    this.lastScene = null
    this.lastSubtitle = 0
    this.lastHud = 0
    this.progressCount = 0
  }
}

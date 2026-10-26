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

import { COMBO_MIN, MENU_RED_ROWS } from './layout.mjs'

/** 旁白/字幕出现到多少算「在说话」。跟 layout 里的 SUBTITLE_MIN 保持一致。 */
export const SCENE_SUBTITLE_MIN = 0.004

/** 黑屏阈值：HUD 区几乎全暗 = 过场/加载/标题。 */
export const SCENE_BLANK_HUD = 0.01

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
  if ((m.menuRows ?? 0) >= MENU_RED_ROWS) {
    return { scene: 'menu', why: `菜单里有 ${m.menuRows} 条红色警告文字行` }
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
  if ((m.hud ?? 0) < SCENE_BLANK_HUD) {
    return { scene: 'blank', why: `HUD 区几乎没有亮像素（${((m.hud ?? 0) * 100).toFixed(2)}%）` }
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
    const hud = m.hud ?? 0

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

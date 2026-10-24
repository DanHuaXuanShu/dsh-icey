/**
 * 画面指纹 + 「游戏无响应」检测
 *
 * 为什么要有这个（2026-10-24 真机事故）：
 *
 * 连玩测到第 3 分钟，游戏进入「角色倒下 + 暂停菜单 + 一个待确认对话框」叠在一起的状态，
 * 之后**键盘完全失效**：Enter ×4、Esc ×1、Q ×1 全部无反应，鼠标只能激活窗口，
 * 五次操作后截图的 SHA256 一模一样。可 `icey_status` 还在报「在前台、可以操作」，
 * 动作队列也照常记「已完成 284」—— 插件以为自己按了，其实全被吞掉。
 *
 * 已有的「卡住」检测（stuck）看的是**画面变化率低**，阈值是「慢」；
 * 而「一个像素都不变」是另一个状态：游戏逻辑停了。这两者必须分开。
 *
 * 判据：连续 N 帧**像素完全相同**，且这期间我们**发过动作**。
 *   要求「发过动作」是为了排除正常静止 —— 比如我们自己按了 Esc 暂停，
 *   画面当然不动，那不是游戏死了，是我们在等。
 *
 * 实测正常待机也不会静止：ICEY 的待机有呼吸、光尘、粒子，画面一直在微动。
 * 所以「完全不变」这个判据在正常情况下几乎不会误报。
 */

/** 连续多少帧完全相同就判定无响应。一帧约 0.7 秒，6 帧≈4 秒。 */
export const FREEZE_FRAMES = 6

/**
 * 画面指纹：FNV-1a 采样哈希。
 *
 * 用 997（素数）做步长，避免和常见贴图宽度/扫描线对齐，
 * 采样量约 rgba.length/997 个字节，1080p 下约 9000 个点，足以区分「同一张图」和「有微动」。
 * 尺寸也进哈希：不同分辨率的帧不该被判成同一张。
 *
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @returns {number} 32 位无符号
 */
export function frameHash(rgba, width = 0, height = 0) {
  let h = 2166136261
  h ^= width & 0xffff
  h = Math.imul(h, 16777619)
  h ^= height & 0xffff
  h = Math.imul(h, 16777619)
  if (!rgba || !rgba.length) return h >>> 0
  for (let i = 0; i < rgba.length; i += 997) {
    h ^= rgba[i]
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 建一个冻结检测器。纯状态机，不碰 IO，selfcheck 能直接用合成帧验证。
 *
 * 用法：
 *   const fd = createFreezeDetector()
 *   fd.feed(rgba, w, h, { acted: true })   // 每帧喂一次，acted=这一轮发过按键
 *   if (fd.frozen) { 停下，把画面交回 }
 *
 * @param {{frames?:number}} [opts]
 */
export function createFreezeDetector({ frames = FREEZE_FRAMES } = {}) {
  let lastHash = null
  let streak = 0          // 连续相同的帧数
  let actedSinceChange = 0 // 自上次画面变化以来发过几次动作
  let frozenAt = null     // 第一次判定冻结时的帧序号（便于报「第几帧开始」）

  return {
    /**
     * @param {Uint8Array|Buffer} rgba
     * @param {number} width
     * @param {number} height
     * @param {{acted?:boolean}} [o] acted = 这一轮是否发了动作
     * @returns {number} 当前连续相同的帧数
     */
    feed(rgba, width, height, { acted = false } = {}) {
      const h = frameHash(rgba, width, height)
      if (lastHash === null || h !== lastHash) {
        // 第一帧（或画面变了）：这帧自己就算「连续 1 帧」，别让它白建基线。
        // 早先写成 streak=0，结果喂 6 帧只得到 streak=5，阈值差一帧。
        lastHash = h
        streak = 1
        actedSinceChange = acted ? 1 : 0
        frozenAt = null
        return streak
      }
      streak++
      if (acted) actedSinceChange++
      if (frozenAt === null && this.frozen) frozenAt = streak
      return streak
    },

    /** 画面完全静止、而且我们在期间确实按过键 → 游戏多半已经无响应 */
    get frozen() {
      return streak >= frames && actedSinceChange > 0
    },

    get streak() {
      return streak
    },

    get actedSinceChange() {
      return actedSinceChange
    },

    reset() {
      lastHash = null
      streak = 0
      actedSinceChange = 0
      frozenAt = null
    },
  }
}

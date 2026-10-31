/**
 * lib/doctor.mjs —— 「现在能不能跑」的体检（纯逻辑层，不碰 IO、不改任何东西）
 * ============================================================================
 * 架构参考 dsh-game-daily 那个插件的「依赖体检 + 四档徽章」。
 *
 * 解决什么：我们有 500 多条 selfcheck 断言，但那是**给开发者跑的**。
 *   用户想知道的是另一件事：此刻我按下去，它能不能动？不能的话缺哪一样、怎么补？
 *   这两件事不一样 —— selfcheck 回答「代码有没有写错」，体检回答「环境够不够用」。
 *
 * 四档的语义（照抄那个插件的分法，因为它这个分法是对的）：
 *   ready    就绪   —— 这一项没问题
 *   risk     有风险 —— 能跑，但某个设置会让它在特定情况下失灵
 *   missing  缺失   —— 缺东西，但还能降级工作
 *   blocked  阻断   —— 这一项不过就跑不了
 *
 * 总结论取**最坏那一档**。不平均、不折算 —— 有一项阻断就是不能跑。
 *
 * 🔴 体检**只读**：不改配置、不抢前台、不发按键。只抓一帧看画面，仅此而已。
 * ============================================================================
 */

/** 四档（数值越大越坏，方便取最坏） */
export const DIAG_LEVEL = {
  ready: 'ready',
  risk: 'risk',
  missing: 'missing',
  blocked: 'blocked',
}

export const DIAG_LABEL = {
  ready: '就绪',
  risk: '有风险',
  missing: '缺失',
  blocked: '阻断',
}

/** 徽章符号 */
export const DIAG_GLYPH = {
  ready: '✓',
  risk: '⚠',
  missing: '✗',
  blocked: '⨯',
}

const LEVEL_RANK = { ready: 0, risk: 1, missing: 2, blocked: 3 }

/**
 * 造一项检查结果。
 * @param {string} id 稳定标识（测试/日志用，不要翻译）
 * @param {string} title 给人看的名字
 * @param {'ready'|'risk'|'missing'|'blocked'} level
 * @param {string} detail 一句话说清看到什么
 * @param {string} [hint] 不过的时候下一步做什么
 */
export function makeItem(id, title, level, detail, hint = '') {
  return { id, title, level, detail, hint }
}

/** 取多项里最坏的一档 */
export function worstLevel(items = []) {
  let worst = DIAG_LEVEL.ready
  for (const it of items) {
    const r = LEVEL_RANK[it?.level]
    if (typeof r === 'number' && r > LEVEL_RANK[worst]) worst = it.level
  }
  return worst
}

/** 数一下各档各有几项 */
export function countByLevel(items = []) {
  const out = { ready: 0, risk: 0, missing: 0, blocked: 0 }
  for (const it of items) if (out[it?.level] !== undefined) out[it.level]++
  return out
}

/**
 * 渲染成给人看的文本。
 * 顺序按严重程度排：阻断在前 —— 用户最该看的是「为什么跑不了」，不是「哪些没问题」。
 */
export function renderDoctor(items = [], opts = {}) {
  const { title = '《艾希》插件体检' } = opts
  if (!items.length) return `${title}：没有任何检查项（这本身就不对）`
  const worst = worstLevel(items)
  const c = countByLevel(items)
  const lines = []
  lines.push(`${title}：${DIAG_LABEL[worst]}（${c.ready} 就绪 / ${c.risk} 有风险 / ${c.missing} 缺失 / ${c.blocked} 阻断）`)
  lines.push('')
  const sorted = [...items].sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0))
  for (const it of sorted) {
    const g = DIAG_GLYPH[it.level] || '?'
    lines.push(`  ${g} ${DIAG_LABEL[it.level] || it.level}  ${padEndWidth(it.title, 10)}${it.detail}`)
    if (it.hint && it.level !== DIAG_LEVEL.ready) lines.push(`      → ${it.hint}`)
  }
  lines.push('')
  if (worst === DIAG_LEVEL.ready) {
    lines.push('⇒ 全部就绪。现在可以 icey_start / icey_play。')
  } else if (worst === DIAG_LEVEL.blocked) {
    lines.push('⇒ 有阻断项，现在跑不起来。先按上面标了 → 的那几条修。')
  } else {
    lines.push('⇒ 能跑，但上面标 → 的那几项会在特定情况下失灵。')
  }
  return lines.join('\n')
}

/**
 * 中文字符占两格，`padEnd` 按字符数补会歪。这里按显示宽度补。
 */
function padEndWidth(s, width) {
  const str = String(s ?? '')
  let w = 0
  for (const ch of str) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
  return w >= width ? `${str}  ` : str + ' '.repeat(width - w)
}

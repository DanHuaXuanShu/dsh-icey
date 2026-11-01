/**
 * lib/inputlang.mjs —— 键盘布局（输入法语言）的**唯一权威形状 + 唯一人话来源**
 * ============================================================================
 * 🔴 为什么单独有这个文件（2026-11-01，检查会话顺手挖出来的第三段断点）：
 *
 *   前一天刚修完「数据流」那一段（win-backend → host → game.status()），
 *   自检 532 全过，commit 里写着「现在 icey_status 能看到 0x0409」——
 *   **但模型看不到**。因为 agent.js 的 describeStatus() 从来没读过 st.inputLang，
 *   字段躺在 status 对象里，人话里一个字都没有。「数据到了」≠「人看到了」。
 *
 *   而且同一条链上有**两套名字、两套形状**，谁接上去都会踩：
 *     attach()  → inputlang  = ensureEnglishInput 形状 {ok, switched, layoutBefore, layoutAfter, ...}
 *     status()  → inputLang  = readInputLang 形状      {ok, lang, hex, english}
 *     act()     → inputLang  = 又是 ensureEnglishInput 形状
 *
 *   最阴的是两种形状的 `ok` 语义相反：
 *     - ensureEnglishInput 的 ok:false = **切不动**（真的坏事）
 *     - readInputLang 的 ok:true + english:false = **读到了，是中文**（也是坏事，但 ok 是 true）
 *   谁要是拿 `ok` 当「能不能按」的判据，从 readInputLang 那条路就永远判断不出毛病。
 *
 *   所以这里定一个形状、一个含义，两边都归一过来：
 *     ok        = 布局现在是英文 ⇒ 按键进得去（统一定义，别的都不许叫 ok）
 *     observed  = 到底读没读到布局（读不到就没资格谈英文不英文）
 *
 *   normalizeInputLang() 吃上面两种原始形状，吐出同一个 canonical 对象；
 *   describeInputLang() 是给模型看的那句人话 —— 只在这里写一次，别处不许再拼。
 * ============================================================================
 */

/** 英文（美式）键盘布局。按键能进游戏的就是它。 */
export const EN_LANG = 0x0409

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const toHex = (n) => (isNum(n) ? (n & 0xffff).toString(16).padStart(4, '0') : null)

/**
 * 把任意一处「布局信息」归一成同一个形状。
 *
 * canonical = {
 *   observed: boolean,        // 读到了布局 id 没有
 *   ok: boolean,              // 布局现在是英文 ⇒ 按键进得去
 *   hex: string|null,         // '0409' / '0804' …
 *   english: boolean|null,    // hex 的语义版（读不到时为 null，不是 false）
 *   switched: boolean,        // 这一次调用是不是真把布局切了
 *   from: string|null,        // 切/读之前是什么布局
 *   error: string|undefined,  // ok 为 true 时不带
 * }
 */
export function normalizeInputLang(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      observed: false, ok: false, hex: null, english: null, switched: false, from: null,
      error: '没有拿到布局信息（调用方没返回，或后端不可用）',
    }
  }
  // 两种形状的布局 id 来源：
  //   ensureEnglishInput → layoutAfter / layoutBefore（切之后 / 切之前）
  //   readInputLang      → lang（就是当前）
  const after = isNum(raw.layoutAfter) ? raw.layoutAfter : (isNum(raw.lang) ? raw.lang : null)
  const before = isNum(raw.layoutBefore) ? raw.layoutBefore : null
  const cur = after ?? before
  const hex = toHex(cur)
  const english = hex === null ? null : hex === toHex(EN_LANG)
  // ok 只有一个含义：现在是不是英文。不从任何原始 ok 抄，避免两种语义混进来。
  const ok = english === true
  return {
    observed: hex !== null,
    ok,
    hex,
    english,
    switched: raw.switched === true,
    from: toHex(before),
    error: ok
      ? undefined
      : String(raw.error || (hex ? `布局是 0x${hex}，不是英文` : '读不到布局')),
  }
}

/**
 * 给模型看的那一句。所有工具都从这里拿，别各自拼。
 *
 * 三种状态必须能一眼分开（2026-11-01 的教训：说不清「读不到」和「读到了是中文」，
 * 模型就会把「没证据」当成「没问题」）：
 *   读不到  → 明说不知道
 *   是英文  → 明说能进
 *   不是英文→ 说清表现 + 怎么修
 */
export function describeInputLang(info) {
  if (!info || typeof info !== 'object') return '键盘布局：没读到（不知道按键会不会被输入法吞掉）。'
  if (!info.observed) {
    return `键盘布局：读不到（${info.error || '原因未知'}）—— 不知道按键会不会被输入法吞掉。`
  }
  if (info.ok) {
    return `键盘布局：0x${info.hex} 英文，按键进得去${info.switched ? '（这次刚切过来）' : ''}。`
  }
  return `键盘布局：0x${info.hex} 不是英文 ⇒ 字母键和方向键会被输入法吞掉`
    + '（表现：esc 能开暂停菜单，但走不动）。'
    + '修法：把游戏窗口点到前台，按 Win+Space 切到英文（任务栏那个「拼」变「英」），再调一次；'
    + '或者重新 icey_start 接一次。'
}

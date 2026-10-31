/**
 * dsh-icey agent 半 —— 给模型用的 6 个 icey_* 工具
 * ============================================================================
 * 设计原则（照 agent-experience 技能的要求）：
 *   - 工具描述写清「什么时候用、返回什么、下一步做什么」，而不是只说是什么
 *   - 失败一律返回结构化 { ok:false, error }，**绝不抛异常**（抛了模型看不到原因）
 *   - icey_look 的截图是真帧，并且**同时**告诉模型「能不能操作」——
 *     「看得到」和「按得动」是两件独立的事，混在一起模型会瞎猜
 *   - 动作返回前后帧差异，但**如实说明**这只证明画面在动，不证明按键生效
 *     （ICEY 待机也有动画），所以别把 diff 当成功判据
 *
 * ⚠️ 输出 schema 的坑（踩过）：宿主的校验器只接受基础类型，写 `type:'json'`
 *    或给 string 加 `required: true` 都会报 JsonSchemaError，**整条插件不激活**。
 *    所以统一用下面两个开放的 object schema。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'
import { session } from './lib/session.mjs'
import { summarizeRun, describeCombat } from './lib/autoplay.mjs'
// 批量动作：把「一串动作」压进一次工具调用，省掉中间的模型往返（每次 6~12 秒）
import { parseActionSpec, MAX_SEQUENCE } from './lib/control.mjs'
import { registerIceyDev } from './lib/devtool.mjs'
import { markLoaded } from './lib/devctl.mjs'

export const name = 'dsh-icey-agent'
export const inject = ['tools', 'attachments']

// 工具清单 —— **唯一权威源**。
// probe/apply-harness 的断言、index.js 的日志都读这里。
// 之前那个数字抄了三份（「8 个」写死在三个文件里），加一个 icey_auto 就挂了一个探针。
// 加工具时只改这一处。
export const TOOL_NAMES = [
  'icey_start', 'icey_status', 'icey_look', 'icey_screenshot', 'icey_act',
  'icey_playbook', 'icey_auto', 'icey_play', 'icey_stop', 'icey_dev',
]

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool
const localFallback = hostDeps.localFallback === true

const text = (value) => [{ type: 'text', text: String(value) }]

/** 纯文字工具的输出 */
const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
}

/** 文字 + 截图的输出：render 里按需取 value.text / value.image / value.extraImage */
const imageOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [
    ...text(value?.text ?? ''),
    ...(value?.image ? [{ type: 'image', attachment: value.image }] : []),
    ...(value?.extraImage ? [{ type: 'image', attachment: value.extraImage }] : []),
  ],
}

/** 工具返回值必须是「无损 JSON」，否则宿主报 value is not lossless JSON */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

/** 把 status 压成一句人话，别让模型自己拼 */
function describeStatus(st) {
  if (!st.running) {
    return `没接上游戏。${st.health?.reason || ''}\n下一步：icey_start（launchMode=attach 接上已经开着的窗口；如果游戏没开，用 steam 或 direct 让插件启动）。`
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
    st.queue ? `动作队列：${st.queue.depth} 个在等，已完成 ${st.queue.done}。` : '',
  ].filter(Boolean)
  // 后台战斗的运行态 + 上一场的结局（2026-10-27 加）。
  // 后台模式下模型拿不到同步返回值，停手原因只能从这里读 —— 不给它，模型就没法复盘。
  const bg = st.background
  // 动作明细：只报「动作 N 次」等于复不了盘（不知道打的是连段还是普攻、有没有闪）
  const fmtActions = (a) => Object.entries(a || {})
    .filter(([, v]) => v > 0)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')
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

/**
 * 字段平铺表（dsh-tools 的 **spec 写法**）→ **标准 JSON Schema**。
 * 只给「本地兜底 defineTool」用：模型 API 的校验器要求 `type: "object"`，
 * 平铺表没有顶层 type，整条请求会被拒
 * （`schema must be a JSON Schema of 'type: "object"', got 'type: null'`）。
 */
export function toSchema(params) {
  if (params && typeof params === 'object' && params.type === 'object') return params // 已经是 schema
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(params || {})) {
    const prop = { ...v }
    delete prop.required
    properties[k] = prop
    if (v && v.required) required.push(k)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length) schema.required = required
  return schema
}

/**
 * 按「用的是谁家的 defineTool」决定 `parameters` 传哪种写法 ——
 * `icey_act schema 无效` 的根就在这里（2026-10-21，WorkBuddy 排查）：
 *   - 宿主 defineTool（`@deepseek-ai/dsh-tools`）吃 **spec 写法**（属性里 `required: true`），
 *     它自己做 spec→JSON Schema 转换；塞标准 schema 进去会被当成参数表再包一层。
 *   - 本地兜底（拿不到宿主那份）吃 **标准 JSON Schema**（对象级 `required: [...]`）；
 *     塞 spec 进去就会被宿主校验器报 `required is not supported on type "string"`。
 * 两边写死同一种都会有一半机器坏。
 */
export function parametersForDefineTool(params, local) {
  return local ? toSchema(params) : params
}

let pluginCtx = null

export function apply(ctx) {
  pluginCtx = ctx
  // 🔴 2026-10-31：刷新「装载时刻」基准。`icey_dev stamp` 靠它判断「文件是不是比代码新」，
  //    而它原来是个模块顶层常量 —— ESM 按 URL 缓存，插件重载时未必重新求值，
  //    于是基准永远停在首次装载，stamp 就一直误报「N 个文件装载之后才改」。
  //    apply() 是插件被启用的入口，一定会重新执行，所以在这儿打点最靠得住。
  markLoaded()
  const tool = (spec) => ctx.effect(() => ctx.tools.register(defineTool({
    ...spec,
    parameters: parametersForDefineTool(spec.parameters, localFallback),
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args, exec))
      } catch (e) {
        // 工具里任何异常都变成结构化失败：模型看得到原因，会话不会炸
        return safe({ ok: false, error: String(e?.message || e) })
      }
    },
  })), `${spec.name} tool`)

  /* ---------------- 1. 启动 ---------------- */

  tool({
    name: 'icey_start',
    description:
      '打开/接上《艾希 ICEY》，然后告诉你能不能操作、画面是什么样。\n'
      + '这是玩游戏的第一步，之后用 icey_look 看画面、icey_act 操作。\n'
      + 'launchMode：attach（默认，接上已经开着的窗口，最稳）/ steam（让 Steam 启动）/ direct（直接跑 exe）。\n'
      + '接上时会自动把游戏线程切到英文键盘布局 —— 中文输入法在中文模式下会把字母键和方向键截给候选框，只剩 esc/enter 能进游戏（表现是「能开暂停菜单但走不动」）。切换结果在返回的 inputlang 里。\n'
      + '返回：接上没接上、窗口信息、能不能操作（不能的话原因）、首帧截图。',
    parameters: {
      launchMode: {
        type: 'string',
        description: 'attach / steam / direct，不填用设置里的 launchMode（默认 attach）',
      },
      waitMs: {
        type: 'integer',
        description: '启动后等游戏窗口出现最多等多久（毫秒，默认 60000）',
      },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      let res
      if (args.launchMode && args.launchMode !== 'attach') {
        const launched = await s.launch(String(args.launchMode))
        if (launched.attached) res = launched
        else {
          const waited = await s.waitForWindow(Number(args.waitMs) || 60_000)
          if (!waited.ok) {
            return {
              text: `启动没成功：${waited.reason}\n${launched.note || ''}\n下一步：手动把游戏打开，再用 icey_start（launchMode=attach）接上。`,
              image: null,
            }
          }
          res = { ...launched, ...waited, attached: true }
        }
      } else {
        res = await s.attach()
        if (!res.attached) {
          return {
            text: `${res.reason}\n下一步：要么手动打开《艾希》，要么用 icey_start（launchMode=steam 或 direct）让插件启动它。`,
            image: null,
          }
        }
      }
      await s.refreshHealth()
      const st = await s.status()
      let image = null
      let lookNote = ''
      try {
        const frame = await s.look({ maxWidth: st.config.maxFrameWidth })
        const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-start' }])
        image = ref
        lookNote = `首帧 ${frame.width}x${frame.height}（原画面 ${frame.health.width}x${frame.health.height}）。`
      } catch (e) {
        lookNote = `但首帧没抓成：${e?.message || e}`
      }
      // 2026-10-29：接上游戏时顺手把规则卡精华带上。
      // 原来新会话必须先单独调一次 icey_playbook 才拿得到，等于白花一轮往返（6~12 秒）。
      // 读不到也不影响接上游戏 —— 规则卡是附加信息，不是接上的前置条件。
      let digest = ''
      try {
        const { PLAYBOOK } = await import('./lib/playbook.mjs')
        digest = PLAYBOOK.digest || ''
      } catch { /* 规则卡读不到就算了 */ }
      const head = [describeStatus(st), lookNote].filter(Boolean).join('\n')
      return {
        text: digest
          ? `${head}\n\n—— 规则卡精华（省得你再单独调一次 icey_playbook；要完整版再调它）——\n${digest}`
          : head,
        image,
      }
    },
  })

  /* ---------------- 2. 状态 ---------------- */

  tool({
    name: 'icey_status',
    description:
      '查《艾希》现在的状态：接上了没、窗口在哪、能不能操作、动作队列里堆了几个、原生后端是否正常。\n'
      + '不确定「刚才那一下到底生效没」的时候先调它，比反复截图省事。',
    parameters: {},
    output: textOutput,
    async execute() {
      const st = await session().status()
      return { text: describeStatus(st) }
    },
  })

  /* ---------------- 3. 看画面 ---------------- */

  tool({
    name: 'icey_look',
    description:
      '看一眼《艾希》现在画面上是什么，返回真实截图（不是缓存、不是模拟）。\n'
      + '每次操作之后都该看一次，确认角色真的动了/走到哪了/有没有怪。\n'
      + '带 `crop: "prompt"` 时只裁**交互提示区**（角色右中那块，原分辨率）——'
      + '那里会浮出白字提示，比如「坐标：时计塔内 / 海拔：638米 / ⏎: 开启强化」。'
      + '想知道「现在能按什么键」就用这个：裁图不缩放，文字看得清。\n'
      + '返回里会写明现在能不能操作；不能操作的话会给出原因。',
    parameters: {
      maxWidth: {
        type: 'integer',
        description: '截图宽度上限（像素，默认用设置里的 1280；越大越清楚也越费 token）',
      },
      crop: {
        type: 'string',
        description: 'full（默认，整屏）/ prompt（只裁交互提示区，原分辨率，用来读提示文字）',
      },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const st = await s.status()
      if (!st.running) {
        return { text: `没接上游戏，看不到画面。${st.health?.reason || ''}\n下一步：icey_start。`, image: null }
      }
      const wantCrop = String(args.crop || 'full').toLowerCase()
      if (wantCrop === 'prompt') {
        const cut = await s.lookCrop({ x0: 0.42, y0: 0.38, x1: 0.99, y1: 0.86 })
        const [ref] = await ctx.attachments.saveImages([{ data: cut.png, mediaType: 'image/png', name: 'icey-prompt' }])
        const promptPct = (cut.promptScore * 100).toFixed(2)
        return {
          text: `交互提示区 ${cut.width}x${cut.height}（原分辨率裁图，未缩放）。白字占比 ${promptPct}%。\n`
            + '上面若有白字提示，直接读它决定按什么键；没有提示通常意味着这里不能互动。\n'
            + '⚠️ 提示框里那个键帽小图标一律是 Enter —— 不要辨认它的字形（2026-10-28 手动操作时把它看成了 J 和 ↑）。',
          image: ref,
        }
      }
      const frame = await s.look({ maxWidth: Number(args.maxWidth) || st.config.maxFrameWidth })
      const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-look' }])
      const lines = [
        `画面 ${frame.width}x${frame.height}（游戏窗口 ${frame.health.width}x${frame.health.height}）。`,
        st.health?.playable
          ? '现在可以操作。'
          : `现在不能操作：${st.health?.reason || '原因未知'}`,
        '想看「现在能按什么键」可以再来一次 icey_look({crop:"prompt"})。',
      ]
      // 2026-10-29：把「黄箭头到底看到了什么」暴露出来。
      // 之前 enemyDir 只在内部用来选方向，外面完全看不见 ——「它有没有发现敌人在左」只能靠猜。
      {
        // ⚠️ 必须是 frame.metrics，不是 frame.health ——
        //   health 只有宽高/黑白比/哈希，读 enemyDir 永远是 undefined（2026-10-29 踩过）。
        const m = frame.metrics || {}
        const dirWord = m.enemyDir === 'left' ? '左' : m.enemyDir === 'right' ? '右' : null
        const ad = m.arrowDiag
        if (dirWord) {
          lines.push(`敌人箭头：指向${dirWord}（黄色实心 = 那边有敌人，和白色空心的「往这走」不是一回事）。`)
        } else if (ad && Array.isArray(ad.bands) && ad.bands.length) {
          const near = ad.bands
            .filter((b) => b.span > 0.01)
            .slice(0, 3)
            .map((b) => `x=${b.x} 宽${(b.span * 100).toFixed(1)}%`)
            .join('、')
          const widest = ad.bands[0]
          const verdict = widest.span < ad.minSpan
            ? `最宽那块 ${(widest.span * 100).toFixed(1)}%，卡在门槛下面`
            : '有块够宽，但被别的条件筛掉了'
          lines.push(
            `敌人箭头：没认出来。画面里最大的黄块 ${near || '（没有像箭头的）'}；`
            + `门槛要求宽度 ≥${(ad.minSpan * 100).toFixed(1)}%（${verdict}）。`,
          )
        } else {
          // 连一块黄带都没形成 —— 把「它眼里的黄」也报出来。
          // 这一层是为了分清两件事：色域定得太窄（有黄但不够亮），还是通道顺序反了（整图根本没有红高蓝低）。
          const yc = ad && typeof ad.yellowish === 'number' ? ad.yellowish : null
          const sm = ad && ad.sample
          lines.push(
            '敌人箭头：没认出黄块。'
            + (yc === null ? '' : `全图「像黄」的像素 ${yc} 个`)
            + (sm ? `，其中最亮的原生 RGB=(${sm.join(',')})` : '（一个都没有）')
            + (ad && ad.size ? `；分析图 ${ad.size}` : '')
            + '。',
          )
        }
      }
      // 后台战斗时把运行态一起带上：这一帧就是「战斗中」的画面，
      // 模型据此决定要不要微调（不看这条，它会以为自己看到的是静止画面）。
      if (st.background?.running) {
        const bg = st.background
        lines.push(`⚠️ 后台战斗正在打（已 ${Math.round((bg.elapsedMs || 0) / 1000)} 秒 / 上限 ${bg.maxSeconds} 秒，`
          + `focus=${bg.order.focus} style=${bg.order.style}）。`)
        lines.push('  微调：icey_play({focus:"left"|"right", style:"aggressive"|"steady"|"cautious"})；'
          + '停手：icey_play({stop:true})。手工 icey_act 这时会被拒（会抢键）。')
        if (bg.lastEvents?.length) lines.push(`  最近：${bg.lastEvents.join(' / ')}`)
      }
      return { text: lines.join('\n'), image: ref }
    },
  })

  /* ---------------- 4. 高清截图 ---------------- */

  tool({
    name: 'icey_screenshot',
    description:
      '给一张《艾希》的高清截图（按原始分辨率，不缩），用来看清楚小字、菜单项、地图细节。\n'
      + 'icey_look 会缩图省 token；要读文字或确认菜单高亮在哪一项，用这个。',
    parameters: {},
    output: imageOutput,
    async execute() {
      const s = session()
      const st = await s.status()
      if (!st.running) return { text: '没接上游戏。先 icey_start。', image: null }
      // 给模型的高清图也要受 attachments 的图片上限约束，所以取一个安全宽度
      const limits = ctx.attachments.imageLimits
      const safeWidth = Math.min(Number(limits?.maxWidth) || 1568, 1568)
      const frame = await s.look({ maxWidth: safeWidth })
      const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-screenshot' }])
      return {
        text: `高清截图 ${frame.width}x${frame.height}（游戏窗口 ${frame.health.width}x${frame.health.height}）。`,
        image: ref,
      }
    },
  })

  /* ---------------- 5. 操作 ---------------- */

  tool({
    name: 'icey_act',
    description:
      '🔴 **平时用这个**（探路 / 交互 / 过剧情）：一眼画面 → 一次给 6~12 个动作（约 10 秒）→ 再看一眼。'
      + '**战斗时反过来交给 `icey_play(preset="fight")`**，你只定战术（打不打、先打谁、何时处决、要不要脱离）——'
      + '2026-10-24 定的分工，2026-10-27 再次确认。'
      + '常用手感：icey_look 看画面 → 用 sequence 一次给 6~12 个动作（约 10 秒）→ 再看一眼。\n'
      + '在《艾希》里做一个动作。可用动作：\n'
      + '  move（dir=up/down/left/right，ms=按住多久，默认 500）—— 走\n'
      + '  dash（dir，ms）—— 朝一个方向冲刺\n'
      + '  attack（ms）—— 普通攻击（J）\n'
      + '  heavy（ms）—— 重攻击（I）\n'
      + '  execute（ms）—— 处决（L）\n'
      + '  jump（ms）—— 跳（空格）\n'
      + '  interact（ms）—— 互动/确认（Enter）\n'
      + '  combo（keys）—— 连段，按给定键序列出招。这是打**取消衔接**（柔化）唯一的方式\n'
      + '      键：j=J i=I l=L u=U o=冲刺 k=跳(空格) w/s/a/d=方向 8/9=强化技\n'
      + '      `s+j`=按住↓点J(凝滞)  `w+j`=按住↑点J(激发)  `a|b`=分阶段(打一半切走)\n'
      + '      例：`jjjji`=颤振  `jjji`=迭影  `jjiii`=磁阱  `jjj|s+j`=小迭影收刀\n'
      + '⚠️ 连段里的 I 必须短按：长按 I 是「刺击+位移」，**会断掉后面的连招**。\n'
      + '⚠️ 站在强化台旁边时**别按空格**——空格在那里会打开强化界面（里面 J 是花钱升级）。\n'
      + '  pause —— 暂停/恢复（Esc）\n'
      + '  menu（item=resume/exit/back）—— 菜单里选一项\n'
      + '⚠️ 按键会**先把游戏窗口抢到前台**（ICEY 只接受前台按键），会打断你正在做的事。\n'
      + '返回：受理没受理、实际按了什么键、动作后的截图。做完看截图确认角色真的动了。\n'
      + '—— 或者**一次走一串**（省掉中间的模型往返，每步要 6~12 秒）：\n'
      + '  sequence=["jjji","move:right:400","dash:up:200","wait:150"]，最多 12 个。\n'
      + '  每项写 "动作:方向:毫秒"，或直接写连段键。批量模式**不返回截图**，要看结果再调 icey_look。',
    parameters: {
      action: {
        type: 'string',
        description: '单个动作：move / dash / attack / heavy / execute / jump / interact / combo / pause / menu（用 sequence 时可不填）',
      },
      sequence: {
        type: 'array',
        items: { type: 'string' },
        description: '一次执行一串动作（最多 12 个）。每项："jjji"（连段）| "move:right:400" | "dash:up:200" | "chase:left:260" | "combo:jjj|s+j" | "menu:resume" | "jump" | "wait:150"',
      },
      gapMs: { type: 'integer', description: '批量模式中动作之间停多少毫秒（默认 120，上限 2000）' },
      keys: {
        type: 'string',
        description: '连段的键序列（combo 用），如 "jjji"、"jjj|s+j"、"w+j|s+j"、"k|s+j"',
      },
      dir: { type: 'string', description: '方向：up / down / left / right（move、dash 用）' },
      ms: { type: 'integer', description: '按住多少毫秒（40–5000）；move 默认 500，其它默认 120' },
      item: { type: 'string', description: '菜单项：resume / exit / back（menu 用）' },
      diff: { type: 'boolean', description: '要不要抓前后两帧算差异（默认 true；关掉快一点）' },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const wantDiff = args.diff !== false

      // ── 批量模式：一次走完一串，省掉中间的模型往返 ──
      // 为什么值得：单发一个动作要 6~12 秒（模型往返），三个动作就是 18~36 秒。
      // 批量之后总共只付一次往返，中间的 gap 只有毫秒级。
      if (Array.isArray(args.sequence) && args.sequence.length) {
        const raw = args.sequence.slice(0, MAX_SEQUENCE)
        const g = Number(args.gapMs)
        const gap = Number.isFinite(g) ? Math.max(0, Math.min(2000, g)) : 120
        const done = []
        const bad = []
        for (const spec of raw) {
          const input = parseActionSpec(spec)
          if (!input) { bad.push(`${spec}（看不懂这个写法）`); continue }
          // wait 不按键，只等游戏 —— 走不到 planAction（它不是动作）。
          // 2026-10-24 实测踩过：selfcheck 里那条「每个简写都能喂 planAction」
          // 当时主动 skip 了 wait，等于测试自己骗自己。
          if (input.action === 'wait') {
            await new Promise((r) => setTimeout(r, input.ms))
            done.push(`${spec} → 等了 ${input.ms}ms`)
            continue
          }
          try {
            const r = await s.act(input, { withDiff: false })
            if (r.ok === false) { bad.push(`${spec}（${r.error}）`); break }
            done.push(`${spec} → ${r.desc || input.action}`)
          } catch (e) {
            bad.push(`${spec}（${e?.message || e}）`)
            break
          }
          if (gap) await new Promise((r) => setTimeout(r, gap))
        }
        const lines = [`一次执行了 ${done.length}/${raw.length} 个动作：`]
        for (const d of done) lines.push('  · ' + d)
        if (bad.length) lines.push(`没执行成：${bad.join('；')}`)
        lines.push('（批量模式不返回截图）下一步：icey_look 看结果。')
        return { text: lines.join('\n'), image: null }
      }

      const res = await s.act(
        { action: args.action, dir: args.dir, ms: args.ms, item: args.item, keys: args.keys },
        { withDiff: wantDiff },
      )
      if (res.ok === false) {
        return {
          text: `动作没执行：${res.error}\n下一步：icey_status 看能不能操作，或 icey_start 先接上。`,
          image: null,
        }
      }
      const lines = [
        `动作：${res.desc || args.action}`,
        `实际按键：${(res.steps || []).join('，') || (res.plan || []).join('，') || '（见状态）'}`,
      ]
      if (wantDiff && res.changed !== undefined && res.changed !== null) {
        lines.push(`前后画面差异 ${(res.diff * 100).toFixed(2)}% —— ${res.changed ? '画面变了' : '画面几乎没变（动作可能没生效）'}。`)
        if (res.note) lines.push(res.note)
      }
      // 动作后再给一帧：模型能直接看到结果，不用再单独调 icey_look
      let image = null
      try {
        const st = await s.status()
        const frame = await s.look({ maxWidth: st.config.maxFrameWidth })
        const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-act' }])
        image = ref
      } catch (e) {
        lines.push(`（动作后的截图没抓成：${e?.message || e}）`)
      }
      return { text: lines.filter(Boolean).join('\n'), image }
    },
  })

  /* ---------------- 5b. 规则卡（玩之前先看一眼，少踩坑） ---------------- */

  tool({
    name: 'icey_playbook',
    description:
      '取《艾希 ICEY》的**游戏规则卡**：怎么判断真的在前进、哪些键是干什么的、'
      + '**哪些门打不开**、哪些操作有危险（比如菜单里的「退出」也是用确认键选的）。\n'
      + '什么时候看：第一次玩这个游戏之前；或者 `icey_play` 返回「这处过不去」而你不知道该往哪走的时候。\n'
      + '内容都是本机实测结论（不是抄文档），比逐步试错省时间。'
      + '想省 token 就带 format=compact，只取一小段精华。',
    parameters: {
      format: { type: 'string', description: 'full（默认，完整规则卡）/ compact（几行精华）' },
    },
    output: textOutput,
    async execute(args) {
      const { PLAYBOOK, playbookText } = await import('./lib/playbook.mjs')
      if (args.format === 'compact') return { text: PLAYBOOK.digest }
      return { text: playbookText() }
    },
  })

  /* ---------------- 6. 自主连玩（不用每步都问） ---------------- */

  tool({
    name: 'icey_auto',
    description:
      '按任务跑一段，达成条件就停 —— 这是「我出路线、插件执行」那层接口。\n'
      + '跟 icey_play 的区别只在两点：① task 一句话说清要干什么，不用记 preset 名；'
      + '② until 能设停止条件（打完这波就停），不用白跑满时间。\n'
      + 'task 关键词：推进/往右/走 → advance；探索/找/逛 → explore；打/战斗/清怪 → fight。\n'
      + 'until=safe：脱离战斗（没敌人、没屏障）就提前停。适合「打完这波叫我」——'
      + '省掉仗早打完还在原地空挥的那段时间。\n'
      + '⚠️ 它仍然没有视觉理解：只会按信号走/打/脱困。遇到锁住的门、需要解谜、'
      + '或者要走高处入口，还是得你自己用 icey_look + icey_act 判断。\n'
      + '典型用法：icey_auto({task:"往右推进", until:"safe", seconds:60})'
      + ' → 它一路推进、遇敌自己打、打完就停回来报告。',
    parameters: {
      task: { type: 'string', description: '一句话任务（推进 / 探索 / 战斗）' },
      seconds: { type: 'integer', description: '最多跑多久（默认 90）。硬上限看预设：战斗 120 秒、其余 60 秒 —— 超了会被截断，摘要里会明确告诉你实际按多少秒跑' },
      until: { type: 'string', description: 'safe = 脱离战斗就提前停；不填 = 跑满 seconds' },
      dir: { type: 'string', description: '推进方向 right / left，默认 right' },
      brief: { type: 'boolean', description: 'true = 不带截图（省 token）' },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const st = await s.status()
      if (!st.running) {
        return { text: `没接上游戏。${st.health?.reason || ''}\n下一步：icey_start。`, image: null }
      }
      const task = String(args.task || '').toLowerCase()
      let preset = 'advance'
      if (/战|打|清|fight/.test(task)) preset = 'fight'
      else if (/探|找|逛|搜|explore/.test(task)) preset = 'explore'
      const brief = args.brief === true
      const res = await s.play({
        preset,
        seconds: args.seconds ?? 90,
        until: args.until === 'safe' ? 'safe' : undefined,
        dir: args.dir,
        maxFrames: brief ? 0 : 2,
        historyLen: 6,
      })
      if (!res.ok) {
        return { text: `没跑起来：${res.error}\n下一步：icey_status 看看能不能操作。`, image: null }
      }
      const lines = [`任务「${args.task}」→ 按 ${preset} 执行`, summarizeRun(res)]
      if (res.eventDigest) {
        lines.push('途中事件：', ...res.eventDigest.split('\n').map((l) => `  ${l}`))
      }
      // 2026-10-28 补：icey_play 早就渲染了 safetyPaused，icey_auto 漏了 ——
      // 于是用它停手的人不知道游戏被 Esc 暂停了，接着发 move 全被暂停菜单吃掉。
      if (res.safetyPaused) {
        lines.push('⚠️ 结束时还在战斗，我按了 Esc 把游戏暂停了（不暂停的话怪会继续打，真被打死过两次）。接手前先按一次 Esc 继续。')
      }
      return { text: lines.join('\n'), image: null }
    },
  }),

  tool({
    name: 'icey_play',
    description:
      '🔴 **战斗默认这样用：`background:true` 开一次，之后一边看一边调**（2026-10-27 改）。\n'
      + '平时（探路/交互/过剧情）由你亲手按 `icey_act`；战斗交给本工具，因为插件一次决策约 0.7 秒，'
      + '你一次工具往返 6~12 秒 —— 反射层面你必然慢半拍。\n'
      + '**战斗的标准循环**：`icey_play({preset:"fight", background:true, seconds:90})` → 立即返回，它自己打 → '
      + '你随时 `icey_look` 看一眼 → 要调就发一条 `icey_play({focus:"left"})` / `({style:"cautious"})`'
      + '（约 0.7 秒生效，**不重启、不丢战斗进度**）→ `icey_play({stop:true})` 收手。\n'
      + '不带 `background` 的同步模式仍然可用（阻塞到跑完才返回），但它跑的时候你发不出别的工具 —— '
      + '只有「一次跑完、中间不想管」时才用它。\n'
      + '🔴 **硬闸（代码里真的会拦）**：① 你 90 秒没 act/look/play，后台战斗自动停手；'
      + '② 单段上限：非战斗 60 秒、`preset="fight"` 120 秒；③ 停手后重新开打要隔 10 秒；'
      + '④ 它跑的时候手工 `icey_act` 会被拒（会抢键），改走微调或停手。\n'
      + '**你负责战术层**：打不打、先打哪边（focus）、打多凶（style）、什么时候停手。'
      + '⚠️ 这里没有「撤退」选项 —— 2026-10-26 用户明确说过不要撤，血低只降攻击欲望。\n'
      + '默认手感是：icey_look 看一眼 → icey_act(sequence=[...]) 亲手打十几秒 → 再看一眼。'
      + '只有用户明确说「托管」「你自己跑一会儿」「玩 30 分钟别管我」，或者只是想清一波小怪时，才用这个。\n'
      + '**自己连着玩一段**，中途不用再问任何人。一次调用跑完一整段：自动决定走位/攻击/过对话，'
      + '结束后返回「做了什么、途中发生了什么、几张关键截图」。\n'
      + '什么时候用：想让游戏往前走一段（推进剧情、清一波小怪、探路），而不是每一步都要你决定。\n'
      + 'preset：advance（默认，往右推进 + 节奏性挥刀）/ fight（原地连打）/ explore（走得多、偶尔跳）。\n'
      + '⚠️ 说清楚它的能力边界：这是**侧滚轴游戏的常识性自动驾驶**，'
      + '靠几个信号决策（画面动不动、血条在不在、2.5 秒有没有净进展），**没有视觉理解**。\n'
      + '它会自己推进、打架；卡住时按阶梯挨个试（退一步 → 确认 → 跳 → 重击），'
      + '一轮都失败就**判定这条路走不通、掉头走另一边**，并把「第 N 秒这处过不去」写进 events。\n'
      + '看到 events 里那条「过不去」，就该自己看截图判断这是锁住的门、要等剧情、还是需要别的办法——'
      + '而不是继续硬撞。连续几轮没进展它会主动停下把画面交回。\n'
      + '（确认键每次连玩最多盲按 3 次：暂停菜单里的「退出」也是用它选的，按多了可能把游戏退掉。）\n'
      + '第一次玩建议先调 icey_playbook 看一眼规则卡（哪些门打不开、哪些键会退游戏），能少踩坑。\n'
      + '返回里的截图按时间顺序排列，用它们判断这轮有没有实际进展。',
    parameters: {
      seconds: { type: 'integer', description: '连玩多久（默认 30）。硬上限：preset=fight 120 秒，其余 60 秒 —— 传更大的值会被截断，摘要会告诉你实际跑了多少秒' },
      preset: { type: 'string', description: 'advance / fight / explore，默认 advance' },
      captureEvery: { type: 'integer', description: '每隔几秒留一张途中截图（默认 12）' },
      maxFrames: { type: 'integer', description: '最多留几张截图（0–4，默认 3；每张都花 token）' },
      dir: { type: 'string', description: '推进方向 right / left，默认 right' },
      historyLen: { type: 'integer', description: '带回来多少条「最近动作」历史（0–20，默认 8；0 = 不带）' },
      brief: {
        type: 'boolean',
        description: 'true = 不带截图，只回结构化事件摘要 + 指标（省 token，适合「先跑一段看看情况」）。'
          + '默认 false 带图。⚠️ 不带图就看不到画面细节，判不准的时候还是得开图看一眼。',
      },
      background: {
        type: 'boolean',
        description: 'true = 后台开打：启动后立刻返回，战斗在插件里继续跑，你随后可以一边 icey_look 一边微调。'
          + '战斗推荐用它（默认的同步模式会一直占着这次调用，期间你发不出别的工具）。',
      },
      stop: {
        type: 'boolean',
        description: 'true = 叫停正在跑的后台战斗（下一步约 1 秒内停，会松键并把画面交回）。',
      },
      focus: {
        type: 'string',
        enum: ['auto', 'left', 'right'],
        description: '先朝哪边打。auto = 插件自己索敌（黄箭头 / 处决提示）；指定后压过自动索敌。',
      },
      style: {
        type: 'string',
        enum: ['auto', 'aggressive', 'steady', 'cautious'],
        description: '战斗欲望档。auto = 按血盾自动分三档；aggressive/steady/cautious 锁死档位。'
          + '注意：这里没有「撤退」——血低只降欲望，2026-10-26 用户明确说过不要撤。',
      },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const brief = args.brief === true
      const st = await s.status()
      if (!st.running) {
        return { text: `没接上游戏，没法连玩。${st.health?.reason || ''}\n下一步：icey_start。`, image: null }
      }

      // ===== 三种调用形态（2026-10-27 加）=====
      //  ① 战斗进行中再调一次 → 「微调」：只改战术参数，不重启、不丢遥测
      //  ② stop:true → 叫停
      //  ③ background:true → 后台开打，立刻返回；模型随后可以一边看画面一边调
      //  ④ 都不带 → 旧的同步模式（阻塞到跑完）
      const bg = s.bgSnapshot()
      if (args.stop === true) {
        const r = s.requestStop()
        return {
          text: r.ok
            ? '已请求停手：插件下一步（约 1 秒内）停，会松键、把画面交回。\n随后 icey_status / 下一次 icey_play 能看到这一段是为什么停的。'
            : `停不了：${r.error}`,
          image: null,
        }
      }
      if (bg.running) {
        // 战斗正在跑：这次调用只当微调用，绝不重启（重启会丢连击窗口和血量基线）
        const patch = {}
        if (args.focus !== undefined) patch.focus = args.focus
        if (args.style !== undefined) patch.style = args.style
        const ranSec = Math.round((bg.elapsedMs || 0) / 1000)
        if (!Object.keys(patch).length) {
          return {
            text: `后台战斗还在跑（已 ${ranSec} 秒 / 上限 ${bg.maxSeconds} 秒），这次调用没带 focus / style，什么都没改。\n`
              + `当前战术：focus=${bg.order.focus} style=${bg.order.style}${bg.orderError ? `（参数有误：${bg.orderError}）` : ''}\n`
              + '要调就带 focus / style；要停就 stop:true；只看画面用 icey_look。',
            image: null,
          }
        }
        const r = s.setOrder(patch)
        if (!r.ok) return { text: `微调没生效：${r.error}`, image: null }
        return {
          text: `已调整：focus=${r.order.focus} style=${r.order.style}（下一步决策就生效，约 0.7 秒）\n`
            + `后台战斗已跑 ${ranSec} 秒 / 上限 ${bg.maxSeconds} 秒。`,
          image: null,
        }
      }

      if (args.background === true) {
        // 先抓一帧再开打：这时循环还没起来，抓帧不会跟它抢窗口。
        let shot = null
        try {
          const frame = await s.look({ maxWidth: 720 })
          const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-fight-start' }])
          shot = ref
        } catch { /* 抓不到不耽误开打 */ }
        // 关键：不 await。让循环在插件里自己跑，工具立刻返回 ——
        // 这才是「插件一直在打、模型随时能看」成立的前提（工具调用是串行的，
        // 一旦 await，模型在这几十秒里就发不出 icey_look）。
        const p = s.play({
          seconds: args.seconds,
          preset: args.preset,
          captureEvery: args.captureEvery,
          maxFrames: 0,          // 后台模式不需要途中截图（模型自己会 look）
          dir: args.dir,
          historyLen: 0,
          background: true,
          order: { focus: args.focus, style: args.style },
        })
        // 这个 promise 没人 await，必须自己接住，否则会变成 unhandledRejection 把宿主吓一跳
        p.catch((e) => { try { s.log?.(`[icey] 后台战斗异常：${e?.message || e}`) } catch { /* 忽略 */ } })
        // 用 1.5 秒竞速区分「已经开打」和「被拒了」：
        // play() 正常要跑几十秒才 resolve，这么短时间内 resolve 只可能是拒绝或立刻出错。
        const early = await Promise.race([p, new Promise((r) => setTimeout(() => r('RUNNING'), 1500))])
        if (early !== 'RUNNING') {
          return { text: `后台战斗没开起来：${early?.error || '未知原因'}`, image: shot }
        }
        return {
          text: `后台战斗已开始（${args.preset || 'advance'}，上限 ${args.preset === 'fight' ? 120 : 60} 秒）。\n`
            + '它现在自己在打 —— 你可以做三件事：\n'
            + '  · icey_look 看一眼画面（战斗中随时可看）\n'
            + '  · icey_play({focus:"left"|"right", style:"aggressive"|"steady"|"cautious"}) 微调，约 0.7 秒生效\n'
            + '  · icey_play({stop:true}) 叫停\n'
            + '⚠️ 它在跑的时候手工 icey_act 会被拒绝（会抢键）。你 90 秒不参与它会自己停。',
          image: shot,
        }
      }

      const res = await s.play({
        seconds: args.seconds,
        preset: args.preset,
        captureEvery: args.captureEvery,
        maxFrames: brief ? 0 : args.maxFrames,
        dir: args.dir,
        historyLen: args.historyLen,
      })
      if (!res.ok) {
        return { text: `连玩没开始：${res.error}\n下一步：icey_status 看能不能操作，或 icey_start 先接上。`, image: null }
      }

      const lines = [summarizeRun(res)]
      // 跨调用记忆：上一轮干了什么、卡在哪。模型每次调用都是「第一次看这个世界」，
      // 不给它这条，它会重复上一轮犯的错。
      if (res.previous) {
        const { describeRun } = await import('./lib/run-history.mjs')
        const prev = describeRun(res.previous)
        if (prev) lines.push(`上一轮：${prev}`)
      }
      // 结构化事件摘要：urgent 置顶、notable 其次，info 只计数不展开。
      // 这是给「不想看每帧」的模型准备的——不传 brief 也给，因为它比 events 那串字符串更有层次。
      if (res.eventDigest) {
        lines.push('途中事件（按轻重排）：', ...res.eventDigest.split('\n').map((l) => `  ${l}`))
      }
      if (res.eventByKind && Object.keys(res.eventByKind).length) {
        const brief2 = Object.entries(res.eventByKind).map(([k, v]) => `${k}×${v}`).join(' ')
        lines.push(`事件计数：${brief2}`)
      }
      // 最近动作历史（参考 GameScaling 的 history_len）：让模型跨调用也能接上上文
      if (Array.isArray(res.history) && res.history.length) {
        const tail = res.history.slice(-6).map((h) => {
          const what = h.action === 'combo' && h.keys ? `连段 ${h.keys.toUpperCase()}` : h.action
          const dir = h.dir ? ` ${h.dir}` : ''
          const why = h.why ? ` — ${h.why}` : ''
          return `${h.t}s ${what}${dir}${why}`
        })
        lines.push('最近动作：', ...tail.map((t) => `  · ${t}`))
      }
      // 一次调用只带一张图（第一张）进消息，其余提示可用 frames 数量说明——
      // 多图很吃 token，而这一轮的主要信息在摘要里。
      let image = null
      let extraImage = null
      if (!brief && res.frames?.length) {
        try {
          const refs = await ctx.attachments.saveImages(
            res.frames.map((f, i) => ({
              data: f.png,
              mediaType: 'image/png',
              name: `icey-play-${i + 1}-${f.reason || 'periodic'}`,
            })),
          )
          image = refs[0] || null
          // 第二张优先给**字幕区**，其次才是交互提示区：
          //   · 字幕 = 旁白在说什么。ICEY 的 Meta 玩法就是旁白直接命令/诱导你
          //     （「往左走」「别碰那个按钮」），听不听是决策，不是装饰 ⇒ 优先级最高。
          //   · 提示区 = 「这里能不能按 Enter」，只在没有旁白时才占这个位置。
          const subIdx = res.frames.findIndex((f) => f.reason === 'subtitle')
          const promptIdx = res.frames.findIndex((f) => f.reason === 'prompt')
          const pickIdx = subIdx >= 0 ? subIdx : promptIdx
          if (pickIdx > 0) {
            extraImage = refs[pickIdx] || null
            lines.push(subIdx >= 0
              ? '（第二张图是**旁白/字幕区**的原分辨率裁图 —— 直接读上面的字：它在说什么、是不是在下命令；'
                + '听不听由你判断，旁白经常故意误导）'
              : '（第二张图是**交互提示区**的原分辨率裁图 —— 上面若有提示文字，直接读它决定按什么键）')
          } else if (pickIdx === 0) {
            // 这一轮没有现场整屏（比如没卡住、也没到采样点），第一张就是那张裁图
            lines.push(subIdx >= 0
              ? '（这张图就是**旁白/字幕区**的原分辨率裁图 —— 直接读上面的字）'
              : '（这张图就是**交互提示区**的原分辨率裁图 —— 直接读上面的字）')
          }
          if (extraImage) {
            const rest = refs.length - 1 - (pickIdx > 0 ? 1 : 0)
            if (rest > 0) lines.push(`（另外还留了 ${rest} 张，需要看的话用 icey_look 单独取）`)
          }
        } catch (e) {
          lines.push(`（途中截图没存成：${e?.message || e}）`)
        }
      }
      if (res.safetyPaused) {
        lines.push('⚠️ 结束时还在战斗，我按了 Esc 把游戏暂停了（不暂停的话怪会继续打，真被打死过两次）。接手前先按一次 Esc 继续。')
      }
      if (brief) lines.push('（brief 模式：这轮没带截图，只有事件和指标。要看画面就再调一次不带 brief。）')
      lines.push('下一步：看截图判断进展；要继续就再调一次 icey_play，想精确操作就 icey_act。')
      return { text: lines.join('\n'), image, extraImage }
    },
  })

  /* ---------------- 7. 停止 ---------------- */

  tool({
    name: 'icey_stop',
    description:
      '停止插件对《艾希》的接管：松开所有按键、关掉实时画面、释放原生后端（正在连玩的话也会停）。\n'
      + '注意：**不会关闭游戏本身**，游戏继续开着，随时可以 icey_start 接回来。\n'
      + '做完一轮、或者要交还控制权给用户的时候调它（保证不留卡住的键）。',
    parameters: {},
    output: textOutput,
    async execute() {
      const s = session()
      const released = await s.releaseAll()
      await s.stop('icey_stop')
      return {
        text: `已停止接管。松开的键：${released.length ? released.join('、') : '（没有按住的键）'}。\n游戏本身还开着（如果它本来就开着）。要再玩就 icey_start。`,
      }
    },
  })

  /* 开发维护（stamp / probe / reload / selfcheck）—— 正常玩游戏用不到 */
  registerIceyDev(tool, () => pluginCtx)
}

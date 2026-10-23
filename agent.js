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
import { summarizeRun } from './lib/autoplay.mjs'

export const name = 'dsh-icey-agent'
export const inject = ['tools', 'attachments']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool
const localFallback = hostDeps.localFallback === true

const text = (value) => [{ type: 'text', text: String(value) }]

/** 纯文字工具的输出 */
const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
}

/** 文字 + 截图的输出：render 里按需取 value.text / value.image */
const imageOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [
    ...text(value?.text ?? ''),
    ...(value?.image ? [{ type: 'image', attachment: value.image }] : []),
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
  return [
    `接上了：${bits.join('，')}。`,
    canAct
      ? '可以操作（按键会先把游戏抢到前台，会打断你正在做的事）。'
      : `现在不能操作：${st.health?.reason || '原因未知'}`,
    st.queue ? `动作队列：${st.queue.depth} 个在等，已完成 ${st.queue.done}。` : '',
  ].filter(Boolean).join('\n')
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

export function apply(ctx) {
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
      return { text: `${describeStatus(st)}\n${lookNote}`, image }
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
      + '返回里会写明现在能不能操作；不能操作的话会给出原因。',
    parameters: {
      maxWidth: {
        type: 'integer',
        description: '截图宽度上限（像素，默认用设置里的 1280；越大越清楚也越费 token）',
      },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const st = await s.status()
      if (!st.running) {
        return { text: `没接上游戏，看不到画面。${st.health?.reason || ''}\n下一步：icey_start。`, image: null }
      }
      const frame = await s.look({ maxWidth: Number(args.maxWidth) || st.config.maxFrameWidth })
      const [ref] = await ctx.attachments.saveImages([{ data: frame.png, mediaType: 'image/png', name: 'icey-look' }])
      const lines = [
        `画面 ${frame.width}x${frame.height}（游戏窗口 ${frame.health.width}x${frame.health.height}）。`,
        st.health?.playable
          ? '现在可以操作。'
          : `现在不能操作：${st.health?.reason || '原因未知'}`,
      ]
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
      '在《艾希》里做一个动作。可用动作：\n'
      + '  move（dir=up/down/left/right，ms=按住多久，默认 500）—— 走\n'
      + '  dash（dir，ms）—— 朝一个方向冲刺\n'
      + '  attack（ms）—— 普通攻击（J）\n'
      + '  heavy（ms）—— 重攻击（I）\n'
      + '  execute（ms）—— 处决（L）\n'
      + '  jump（ms）—— 跳（空格）\n'
      + '  interact（ms）—— 互动/确认（Enter）\n'
      + '  pause —— 暂停/恢复（Esc）\n'
      + '  menu（item=resume/exit/back）—— 菜单里选一项\n'
      + '⚠️ 按键会**先把游戏窗口抢到前台**（ICEY 只接受前台按键），会打断你正在做的事。\n'
      + '返回：受理没受理、实际按了什么键、动作后的截图。做完看截图确认角色真的动了。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'move / dash / attack / heavy / execute / jump / interact / pause / menu',
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
      const res = await s.act(
        { action: args.action, dir: args.dir, ms: args.ms, item: args.item },
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

  /* ---------------- 6. 自主连玩（不用每步都问） ---------------- */

  tool({
    name: 'icey_play',
    description:
      '**自己连着玩一段**，中途不用再问任何人。一次调用跑完一整段：自动决定走位/攻击/过对话，'
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
      + '返回里的截图按时间顺序排列，用它们判断这轮有没有实际进展。',
    parameters: {
      seconds: { type: 'integer', description: '连玩多久（5–300 秒，默认 30）。先试 30 秒，看得动再加长' },
      preset: { type: 'string', description: 'advance / fight / explore，默认 advance' },
      captureEvery: { type: 'integer', description: '每隔几秒留一张途中截图（默认 12）' },
      maxFrames: { type: 'integer', description: '最多留几张截图（0–4，默认 3；每张都花 token）' },
      dir: { type: 'string', description: '推进方向 right / left，默认 right' },
    },
    output: imageOutput,
    async execute(args) {
      const s = session()
      const st = await s.status()
      if (!st.running) {
        return { text: `没接上游戏，没法连玩。${st.health?.reason || ''}\n下一步：icey_start。`, image: null }
      }
      const res = await s.play({
        seconds: args.seconds,
        preset: args.preset,
        captureEvery: args.captureEvery,
        maxFrames: args.maxFrames,
        dir: args.dir,
      })
      if (!res.ok) {
        return { text: `连玩没开始：${res.error}\n下一步：icey_status 看能不能操作，或 icey_start 先接上。`, image: null }
      }

      const lines = [summarizeRun(res)]
      // 一次调用只带一张图（第一张）进消息，其余提示可用 frames 数量说明——
      // 多图很吃 token，而这一轮的主要信息在摘要里。
      let image = null
      if (res.frames?.length) {
        try {
          const refs = await ctx.attachments.saveImages(
            res.frames.map((f, i) => ({ data: f.png, mediaType: 'image/png', name: `icey-play-${i + 1}` })),
          )
          image = refs[0] || null
          if (refs.length > 1) lines.push(`（另外还留了 ${refs.length - 1} 张，需要看的话用 icey_look 单独取）`)
        } catch (e) {
          lines.push(`（途中截图没存成：${e?.message || e}）`)
        }
      }
      lines.push('下一步：看截图判断进展；要继续就再调一次 icey_play，想精确操作就 icey_act。')
      return { text: lines.join('\n'), image }
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
}

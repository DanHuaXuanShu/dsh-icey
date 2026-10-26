/**
 * lib/devtool.mjs —— `icey_dev` 工具本体（开发维护用，正常玩游戏不需要它）
 * ============================================================================
 * 存在的理由只有一条：**改完 lib 要让改动真的跑起来**。
 * 这个插件的逻辑在 lib/ 里，是进程启动时 import 的 ESM；
 * 不重载插件，改完的代码一行都不会执行 —— 2026-10-26 为此白跑了两轮。
 *
 * 所以给一个三档动作：
 *   stamp  —— 看「有哪些文件是进程起来之后改的」，也就是「哪些改动还没生效」。只读。
 *   probe  —— 把插件的 Cordis 上下文导出成结构（有哪些服务、有没有重载入口）。只读。
 *   reload —— 请 DSH 重载 dsh-icey。默认只探不卸；`apply:true` 才真调。
 *
 * 为什么 reload 要先 probe：重载要用的内部接口（服务名、方法名）没有官方文档，
 * 而「自己把自己 dispose 掉」这种写法一旦失败，全部 icey_* 工具当场消失、连报错都发不出去。
 * 所以宁可先看一眼，再动。每次尝试都写日志，失败也能看出卡在哪一步。
 * ============================================================================
 */
import { stampReport, describeCtx, attemptReload, runSelfcheck, readLog, logPath } from './devctl.mjs'

/** @param {(spec:object)=>void} tool agent.js 里的 tool 注册助手 */
export function registerIceyDev(tool, getCtx) {
  tool({
    name: 'icey_dev',
    description:
      '开发维护：让「改完的代码」生效。改完本插件的 lib/ 之后，当前进程跑的仍是旧代码——这个工具用来检查到底哪些文件没生效，并尝试让插件重载。\n'
      + '什么时候用：① 刚改完 lib/*.mjs，想知道改动进没进到正在跑的进程里 → action=stamp；'
      + '② stamp 说有未生效的改动，但不确定能不能自己重载 → action=probe（只读，看有没有入口）；'
      + '③ probe 确认有入口了 → action=reload + apply=true；'
      + '④ 改完代码想立刻跑一遍回归 → action=selfcheck；⑤ action=log 读重载日志。\n'
      + '⚠️ 它不玩游戏、不碰按键。纯运维。默认不产生任何副作用（probe/stamp 都只读）。\n'
      + '⚠️ 如果 reload 之后 icey_* 工具还能正常调用，就是重载成功了；如果工具消失，说明重载打断了注册，需要去 GUI 设置-插件里手动开关一次。',
    parameters: {
      action: {
        type: 'string',
        description: 'stamp（看未生效的改动）/ probe（看有没有重载入口，只读）/ reload（真重载，需 apply=true）/ selfcheck（跑回归）/ log（读日志）。默认 stamp',
      },
      apply: {
        type: 'boolean',
        description: 'reload 时是否真的触发重载。不传/false 时只探不卸（安全默认）。',
      },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const action = String(args?.action || 'stamp').toLowerCase()

      if (action === 'stamp') {
        const r = stampReport()
        return { text: r.text }
      }

      if (action === 'probe') {
        const ctx = getCtx()
        if (!ctx) return { text: '拿不到插件上下文（apply 还没跑过？）。' }
        const info = describeCtx(ctx)
        const path = logPath()
        const dump = JSON.stringify(info, null, 2)
        const lines = [
          '插件上下文的可用面（只读探查，没有副作用）：',
          `自有键：${info.ownKeys.join(', ') || '（空）'}`,
          `原型键：${info.protoKeys.join(', ') || '（空）'}`,
          info.services.length
            ? `找到的服务：${info.services.map((s) => `${s.name}(${s.methods?.length || 0} 个方法)`).join('、')}`
            : '找到的服务：一个都没有（v0.2 起 Cordis 只把注入过的服务挂上来）',
          '',
          ...info.services.map((s) => `· ${s.name}：${(s.methods || []).join(', ') || '（无函数）'}`),
          '',
          ...info.services
            .filter((s) => (s.signatures || []).length)
            .flatMap((s) => (s.signatures || []).map((g) => `· ${s.name}.${g.name} 收 ${g.arity} 个参数 → ${g.src}`)),
          '',
          `完整结构已写进：${path}`,
          '下一步：如果上面出现了像 pluginManager / loader 这样的服务，用 action=reload + apply=true 试着让插件重载。',
        ]
        return { text: lines.join('\n') }
      }

      if (action === 'reload') {
        const ctx = getCtx()
        if (!ctx) return { text: '拿不到插件上下文。' }
        const r = await attemptReload(ctx, { apply: args?.apply === true })
        const lines = [r.log]
        if (r.path) lines.push(`日志：${r.path}`)
        if (r.ok && args?.apply === true) {
          lines.push('已经发出重载请求。**判断成功的唯一标准**：紧接着再调一次 icey_dev action=stamp ——')
          lines.push('如果它报告的「进程启动于」变成了刚刚，说明重载成功、新代码在跑了；')
          lines.push('如果它报的还是老时间，说明重载没触发（那就只能去 GUI 设置-插件里手动开关一次）。')
        } else if (!r.ok) {
          lines.push('没找到可用的重载入口。这就是「GUI 里点一下」那条路的唯一原因，不是懒。')
        }
        return { text: lines.join('\n') }
      }

      if (action === 'selfcheck') {
        const r = await runSelfcheck()
        const lines = [r.ok ? '回归通过：' : `回归失败（退出码 ${r.code}）：`, r.tail || '（没有输出）']
        if (!r.ok && r.stderr) lines.push(`stderr 尾部：${r.stderr}`)
        return { text: lines.join('\n') }
      }

      if (action === 'log') {
        return { text: readLog() }
      }

      return { text: `不认识的 action：${action}（可用：stamp / probe / reload / selfcheck / log）` }
    },
  })
}

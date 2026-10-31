/**
 * lib/vision.mjs —— 抓到的帧怎么变成「人看的」和「模型看的」
 * ============================================================================
 * 两条路，共用一次 GDI 抓帧：
 *   人看（面板实时画面）：RGBA 原样走 SSE 到浏览器，canvas putImageData 直接画。
 *                        **服务端零编码**，不占 CPU，延迟最低。
 *   模型看（icey_look）：纯 JS PNG 编码 → attachments.saveImage。
 *
 * 颜色转换和缩放都在 worker 线程里做完了（见 win-backend.mjs 的 capture），
 * 主线程只管把 Buffer 转手出去。
 *
 * 另外做健康检查：窗口还在吗？在不在前台？抓出来是不是全黑？
 * 这些结论会进 icey_status，让 agent 知道「看得到」和「能操作」是两件事。
 * ============================================================================
 */
import { encodePng, frameHash, nonBlackRatio, diffRatio } from './png.mjs'

/**
 * 抓帧。forAgent=true 时缩到 maxWidth；false 时保持原始分辨率（面板画布自己缩）。
 *
 * 🔴 2026-10-31 加黑帧重试。起因是实机托管「只跑了 5.8 秒就停」，理由报的是
 *    「抓到的画面几乎全黑，游戏可能已最小化」—— 但同一位置、同一窗口紧接着重跑
 *    就跑满了 60 秒。所以那不是渲染器停了，是**抓帧偶发抓回一整帧黑**，
 *    而旧代码一次都不重试，一帧黑的代价是整轮托管中止。
 *
 *    还有一个更麻烦的情况：游戏自己会有**合法的纯黑过场**（选完选项之后有一整秒纯黑）。
 *    它跟「抓帧失败」在像素上完全一样，但一个该等、一个是故障。
 *
 *    所以这里做两件事：
 *      ① 黑帧先重试（默认 2 次，间隔 120ms）—— 解决偶发；
 *      ② 重试完还黑，就**去查窗口状态**再决定怎么说 —— 不赌。
 *         窗口没了/最小化 ⇒ 报真原因；窗口好好的在前台 ⇒ 报「可能是过场」，
 *         而不是甩一句「游戏可能已最小化」把人往错方向带。
 *
 * @returns {Promise<{ok:boolean, width:number, height:number, rgba:Buffer, health:object, ms:number, error?:string, blackout?:boolean}>}
 */
export async function grabFrame(backend, hwnd, opts = {}) {
  const {
    captureMode = 'printwindow', maxWidth = 1280, forAgent = false,
    blackRetries = 2, blackRetryMs = 120, nonBlackMin = 0.02,
  } = opts
  const t0 = Date.now()

  const shotOnce = async () => {
    const cap = await backend.capture(hwnd, captureMode, {
      format: 'rgba',
      maxWidth: forAgent ? maxWidth : 0,
    })
    if (!cap.ok) return { cap, nonBlack: NaN }
    return { cap, nonBlack: nonBlackRatio(cap.data) }
  }

  let last = null
  let lastNonBlack = -1
  for (let attempt = 0; attempt <= blackRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, blackRetryMs))
    last = await shotOnce()
    if (!last.cap.ok) break
    lastNonBlack = last.nonBlack
    if (last.nonBlack >= nonBlackMin) {
      // 抓到了正常画面
      const cap = last.cap
      const health = {
        width: cap.width,
        height: cap.height,
        scaledFrom: cap.scaledFrom || null,
        nonBlack: last.nonBlack,
        hash: frameHash(cap.data),
        attempts: attempt + 1,
      }
      return { ok: true, width: cap.width, height: cap.height, rgba: cap.data, health, ms: Date.now() - t0 }
    }
  }

  // 走到这儿：要么 capture 本身失败，要么重试完还是黑。先弄清窗口到底怎么了。
  const health = last?.cap?.ok
    ? {
        width: last.cap.width,
        height: last.cap.height,
        scaledFrom: last.cap.scaledFrom || null,
        nonBlack: lastNonBlack,
        hash: null,
        attempts: blackRetries + 1,
      }
    : { attempts: blackRetries + 1 }

  if (last && !last.cap.ok) {
    return { ok: false, error: last.cap.error || '抓帧失败', health }
  }

  // 抓得到位图但全黑 —— 查窗口状态，把「过场」和「故障」分开说
  let alive = null
  let foreground = false
  try {
    alive = await backend.alive(hwnd)
    const found = await backend.find('ICEY.exe')
    foreground = !!found?.foreground
  } catch { /* 查不到就按最保守的说法 */ }

  const tries = blackRetries + 1
  if (alive && (!alive.ok || !alive.alive)) {
    return { ok: false, error: `抓了 ${tries} 次都是黑帧，而且游戏窗口已经不在了 —— 它可能被关掉了。`, health }
  }
  if (alive && alive.minimized) {
    return {
      ok: false,
      error: `抓了 ${tries} 次都是黑帧，游戏窗口确实被最小化了 —— 这时候抓帧是黑的、按键也送不进去。等几秒它一般会自己还原，或者手动点任务栏把它调出来。`,
      health,
    }
  }
  // 窗口活着、没最小化 —— 最可能是过场黑屏。这时候报「故障」是错的，会把排查方向带偏。
  return {
    ok: false,
    blackout: true,
    error: `连续 ${tries} 次抓到的都是全黑画面，但游戏窗口还活着${foreground ? '、而且在前台' : ''} —— 这多半是游戏的过场黑屏（剧情里会有整秒纯黑），不是故障。过一两秒再抓一次通常就恢复了。`,
    health,
  }
}

/** RGBA → PNG（模型看的那条路） */
export function toPng(frame) {
  return encodePng(frame.width, frame.height, frame.rgba)
}

/**
 * 判断「能不能操作」：窗口在、可见、并且在前台。
 * SendInput 只对前台窗口有效（实测 ICEY 完全无视 PostMessage），
 * 所以「在前台」是能不能动手的硬条件，必须如实报告。
 */
export async function assessPlayability(backend, hwnd, opts = {}) {
  const { allowFocus = true } = opts
  const alive = await backend.alive(hwnd)
  if (!alive.ok || !alive.alive) {
    return { playable: false, reason: '游戏窗口已经关了', alive: false }
  }
  const found = await backend.find('ICEY.exe')
  const foreground = !!found.foreground
  if (alive.minimized) {
    return {
      playable: false, alive: true, foreground: false, minimized: true,
      reason: '游戏窗口被最小化了：这时候抓帧是黑的、按键也送不进去。等几秒它一般会自己还原（实测约 15 秒），或者手动点任务栏把它调出来。',
    }
  }
  if (!foreground && !allowFocus) {
    return {
      playable: false, alive: true, foreground: false,
      reason: '游戏不在前台，而设置里关掉了「自动抢前台」。要操作请自己把 ICEY 窗口切到前面，或打开 allowFocus。',
    }
  }
  return { playable: true, alive: true, foreground, minimized: false }
}

/**
 * 确保能动手：不在前台就抢前台（受 allowFocus 控制）。
 * 返回里带 `previousHwnd` —— 动作结束后要把焦点还回去，否则用户的 DSH 就一直被游戏压着。
 * @returns {{ok: boolean, focused: boolean, previousHwnd?: number, reason?: string}}
 */
export async function ensureForeground(backend, hwnd, opts = {}) {
  const { allowFocus = true } = opts
  const found = await backend.find('ICEY.exe')
  if (!found.ok || !found.found) return { ok: false, focused: false, reason: '找不到 ICEY 窗口' }
  // 记下用户原来在用哪个窗口，动作做完还给他
  const prev = await backend.getForeground().catch(() => null)
  const previousHwnd = prev?.ok && prev.hwnd !== found.hwnd ? prev.hwnd : 0
  if (found.foreground) return { ok: true, focused: true, previousHwnd }
  if (!allowFocus) {
    return { ok: false, focused: false, previousHwnd, reason: '游戏不在前台，设置里关掉了自动抢前台（allowFocus=false）' }
  }
  const res = await backend.focus(found.hwnd)
  if (res.ok && res.isTarget) return { ok: true, focused: true, previousHwnd }
  return {
    ok: false, focused: false, previousHwnd,
    reason: '抢前台失败：Windows 拒绝了焦点切换。手动点一下 ICEY 窗口标题栏再试。',
  }
}

/**
 * 把焦点还给动作开始前的窗口。
 * 为什么必须做：抢前台会打断用户正在做的事；用完不还，DSH 就一直是后台窗口，
 * 用户的感觉就是「开了艾希之后 DSH 不能用了」。
 */
export async function restoreForeground(backend, previousHwnd) {
  if (!previousHwnd) return { restored: false, reason: '没有记录到原前台窗口' }
  const fg = await backend.getForeground().catch(() => null)
  if (fg?.ok && fg.hwnd === previousHwnd) return { restored: true, already: true }
  const res = await backend.focus(previousHwnd).catch(() => null)
  return { restored: !!res?.isTarget }
}

export { frameHash, nonBlackRatio, diffRatio }

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
 * @returns {Promise<{ok:boolean, width:number, height:number, rgba:Buffer, health:object, ms:number, error?:string}>}
 */
export async function grabFrame(backend, hwnd, opts = {}) {
  const { captureMode = 'printwindow', maxWidth = 1280, forAgent = false } = opts
  const t0 = Date.now()
  const cap = await backend.capture(hwnd, captureMode, {
    format: 'rgba',
    maxWidth: forAgent ? maxWidth : 0,
  })
  if (!cap.ok) return { ok: false, error: cap.error || '抓帧失败' }
  const health = {
    width: cap.width,
    height: cap.height,
    scaledFrom: cap.scaledFrom || null,
    nonBlack: nonBlackRatio(cap.data),
    hash: frameHash(cap.data),
  }
  if (health.nonBlack < 0.02) {
    return {
      ok: false,
      error: '抓到的画面几乎全黑 —— 游戏可能已最小化、被遮挡，或者渲染器停了。把游戏窗口调出来再试。',
      health,
    }
  }
  return { ok: true, width: cap.width, height: cap.height, rgba: cap.data, health, ms: Date.now() - t0 }
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

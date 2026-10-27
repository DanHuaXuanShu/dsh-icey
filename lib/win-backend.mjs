/**
 * lib/win-backend.mjs —— Windows 原生后端：找窗口、抓帧、发按键、抢前台
 * ============================================================================
 * 🔴 为什么用 worker 线程而不是子进程：
 *   抓一帧 1606x935 是 ~6MB（BGRA）。走子进程 stdin/stdout 就是每帧 6MB 序列化 +
 *   管道搬运，10fps 就是 60MB/s —— 不现实。worker 线程传 ArrayBuffer 是**转移**语义，
 *   零拷贝（probe 实测单帧 93ms，含 GetDIBits）。
 *   代价：koffi 出问题会拖宿主下水。所以这里只暴露极小的一组调用，且都是已实测过的。
 *
 * 🔴 为什么按键必须是 SendInput 而不是 PostMessage：
 *   实测（probe/focus-test.mjs）：ICEY 是 Unity 游戏，走 Raw Input / GetAsyncKeyState，
 *   **完全无视 WM_KEYDOWN**（前台发、后台发都没反应）。而 SendInput 只要游戏在前台就有效。
 *   ⇒ 输入的唯一可行路径是 SendInput，且必须先把游戏窗口抢到前台。
 *
 * 可单独跑（冒烟测试）：node lib/win-backend.mjs  → stdin 收 JSON 行，stdout 回 JSON 行
 * 也可被 worker 线程加载（parentPort 存在时走 postMessage）
 * ============================================================================
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { bgraToRgba, fitWidth } from './png.mjs'

/* ============================ koffi 解析 ============================ */
/**
 * koffi 是 profile 里的依赖（插件包自己装不了原生模块）。
 * 依次试：显式配置的路径 → DSH profile 树 → 裸 import。
 */
function loadKoffi(explicitPath) {
  const tried = []
  const roots = []
  if (explicitPath) roots.push(explicitPath)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  roots.push(join(dshHome, 'profiles', profile, 'package.json'))
  roots.push(join(dshHome, 'profiles', 'desktop', 'package.json'))
  roots.push(join(dshHome, 'package.json'))

  for (const root of roots) {
    try {
      const req = createRequire(root)
      const k = req('koffi')
      if (k) return { koffi: k, from: root }
    } catch (e) {
      tried.push(`${root}: ${e?.code || e?.message}`)
    }
  }
  tried.push('裸 import 兜底')
  throw Object.assign(new Error('koffi 拿不到'), { tried })
}

let koffi
let koffiFrom = ''
try {
  const r = loadKoffi(process.env.DSH_ICEY_KOFFI_PATH || '')
  koffi = r.koffi
  koffiFrom = r.from
} catch (e) {
  // 没有 koffi：后端降级成「只能看不能动」，由宿主侧如实报告
  koffi = null
  koffiFrom = `不可用（${(e.tried || []).join(' | ')}）`
}

/* ============================ 原生绑定 ============================ */
let api = null

function bind() {
  if (api) return api
  if (!koffi) throw new Error(`koffi 不可用：${koffiFrom}`)

  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // ⚠️ 所有 struct 必须**先注册**，才能在 func() 签名里引用，否则
  //    "Unknown or invalid type name 'RECT'"
  const RECT = koffi.struct('ICEY_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
  const POINT = koffi.struct('ICEY_POINT', { x: 'int32_t', y: 'int32_t' })
  const BITMAPINFOHEADER = koffi.struct('ICEY_BITMAPINFOHEADER', {
    biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
    biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
    biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
  })
  const BITMAPINFO = koffi.struct('ICEY_BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })
  // x64 的 INPUT 是 40 字节（type 4 + 对齐 4 + union 32）。KEYBDINPUT 只有 24，
  // 直接用它会得到 32 字节的 INPUT ⇒ SendInput 返回 0 且 GetLastError=87。
  // 用 raw[40] 最稳（实测 SendInput 返回 1）。
  const INPUTBUF = koffi.struct('ICEY_INPUTBUF', { raw: 'uint8_t[40]' })
  const ENUMPROC = koffi.proto('bool ICEY_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)')

  const f = {
    // 窗口
    EnumWindows: user32.func('bool EnumWindows(void *cb, intptr_t p)'),
    IsWindow: user32.func('bool IsWindow(intptr_t h)'),
    IsWindowVisible: user32.func('bool IsWindowVisible(intptr_t h)'),
    IsIconic: user32.func('bool IsIconic(intptr_t h)'),
    GetWindowTextW: user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *b, int m)'),
    GetWindowRect: user32.func('bool GetWindowRect(intptr_t h, _Out_ ICEY_RECT *r)'),
    GetClientRect: user32.func('bool GetClientRect(intptr_t h, _Out_ ICEY_RECT *r)'),
    GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)'),
    GetForegroundWindow: user32.func('intptr_t GetForegroundWindow()'),
    GetSystemMetrics: user32.func('int GetSystemMetrics(int index)'),
    PostMessageW: user32.func('bool PostMessageW(intptr_t h, uint32_t msg, intptr_t w, intptr_t l)'),
    ShowWindow: user32.func('bool ShowWindow(intptr_t h, int c)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(intptr_t h)'),
    BringWindowToTop: user32.func('bool BringWindowToTop(intptr_t h)'),
    SetWindowPos: user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    AttachThreadInput: user32.func('bool AttachThreadInput(uint32_t from, uint32_t to, bool attach)'),
    // 扩展样式：查有没有残留 WS_EX_TOPMOST（残留 = 游戏永远盖住 DSH）
    GetWindowLongW: user32.func('int32_t GetWindowLongW(intptr_t h, int index)'),
    // 输入
    SendInput: user32.func('uint32_t SendInput(uint32_t n, _In_ ICEY_INPUTBUF *i, int cb)'),
    MapVirtualKeyW: user32.func('uint32_t MapVirtualKeyW(uint32_t code, uint32_t mapType)'),
    VkKeyScanW: user32.func('int16_t VkKeyScanW(uint16_t ch)'),
    GetAsyncKeyState: user32.func('int16_t GetAsyncKeyState(int vk)'),
    // 键盘布局：中文输入法会把字母键/方向键截走，必须能查、能切
    GetKeyboardLayout: user32.func('intptr_t GetKeyboardLayout(uint32_t idThread)'),
    LoadKeyboardLayoutW: user32.func('intptr_t LoadKeyboardLayoutW(_In_ const char16_t *id, uint32_t flags)'),
    ActivateKeyboardLayout: user32.func('intptr_t ActivateKeyboardLayout(intptr_t hkl, uint32_t flags)'),
    // 抓帧
    GetDC: user32.func('intptr_t GetDC(intptr_t h)'),
    ReleaseDC: user32.func('int ReleaseDC(intptr_t h, intptr_t dc)'),
    PrintWindow: user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32_t flags)'),
    SetProcessDpiAwarenessContext: user32.func('bool SetProcessDpiAwarenessContext(intptr_t v)'),
    // GDI
    CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
    SelectObject: gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t obj)'),
    DeleteObject: gdi32.func('bool DeleteObject(intptr_t obj)'),
    DeleteDC: gdi32.func('bool DeleteDC(intptr_t dc)'),
    BitBlt: gdi32.func('bool BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32_t rop)'),
    GetDIBits: gdi32.func('int GetDIBits(intptr_t dc, intptr_t bmp, uint32_t start, uint32_t lines, _Out_ void *bits, _Inout_ ICEY_BITMAPINFO *bi, uint32_t usage)'),
    // 线程
    GetCurrentThreadId: kernel32.func('uint32_t GetCurrentThreadId()'),
    // 进程名
    OpenProcess: kernel32.func('intptr_t OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool CloseHandle(intptr_t h)'),
    QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(intptr_t proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
  }

  // 高 DPI：不设的话 GetWindowRect 给的是缩放后的逻辑像素，和 PrintWindow 的位图对不上
  try { f.SetProcessDpiAwarenessContext(-4) } catch { /* Electron 已经设过了 */ }

  api = { koffi, f, RECT, POINT, BITMAPINFO, INPUTBUF, ENUMPROC }
  return api
}

/* ============================ 工具函数 ============================ */

function winTitle(hwnd) {
  const { f } = bind()
  const b = new Uint16Array(512)
  const n = f.GetWindowTextW(hwnd, b, 512)
  if (n <= 0) return ''
  return Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}

function winRect(hwnd) {
  const { f } = bind()
  const r = {}
  if (!f.GetWindowRect(hwnd, r)) return null
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top }
}

function procName(pid) {
  const { f } = bind()
  const h = f.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid)
  if (!h) return ''
  try {
    const buf = new Uint16Array(1024)
    const size = [1024]
    if (!f.QueryFullProcessImageNameW(h, 0, buf, size)) return ''
    const s = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le')
    return s.split(/[\\/]/).pop() || ''
  } finally {
    f.CloseHandle(h)
  }
}

/** 枚举所有顶层窗口（只回标题非空的） */
function listWindows(filter = '') {
  const { f, ENUMPROC } = bind()
  const out = []
  const cb = koffi.register((hwnd) => {
    try {
      const title = winTitle(hwnd)
      if (!title) return true
      const pid = [0]
      f.GetWindowThreadProcessId(hwnd, pid)
      const exe = procName(pid[0])
      const rect = winRect(hwnd)
      const item = {
        hwnd: Number(hwnd), pid: pid[0], exe, title: title.slice(0, 120),
        rect, visible: !!f.IsWindowVisible(hwnd), minimized: !!f.IsIconic(hwnd),
      }
      const needle = filter.toLowerCase()
      if (!needle || title.toLowerCase().includes(needle) || exe.toLowerCase().includes(needle)) out.push(item)
    } catch { /* 单个窗口出错不影响枚举 */ }
    return true
  }, koffi.pointer(ENUMPROC))
  try { f.EnumWindows(cb, 0) } finally { koffi.unregister(cb) }
  return out
}

/**
 * 找 ICEY 窗口。按 exe 名精确匹配（标题可能被玩家改，且别的窗口标题里也可能有 ICEY）。
 * 多个候选时挑面积最大且可见的。
 */
function findIcey(exeName = 'ICEY.exe') {
  const all = listWindows('')
  const mine = all.filter((w) => w.exe.toLowerCase() === exeName.toLowerCase() && w.rect && w.rect.width > 200)
  if (!mine.length) return null
  mine.sort((a, b) => {
    if (a.minimized !== b.minimized) return a.minimized ? 1 : -1
    return b.rect.width * b.rect.height - a.rect.width * a.rect.height
  })
  const w = mine[0]
  return {
    hwnd: w.hwnd, pid: w.pid, exe: w.exe, title: w.title, rect: w.rect,
    minimized: w.minimized, visible: w.visible,
    candidates: mine.length,
  }
}

/* ============================ 抓帧 ============================ */
/**
 * 抓一帧，返回 top-down BGRA。
 * @param {number} hwnd
 * @param {'printwindow'|'bitblt'} mode
 */
function capture(hwnd, mode = 'printwindow') {
  const { f, BITMAPINFO } = bind()
  const rect = winRect(hwnd)
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('窗口矩形无效（窗口可能已关闭）')
  const w = rect.width, h = rect.height

  const screenDc = f.GetDC(0)
  if (!screenDc) throw new Error('GetDC 失败')
  let memDc = 0, bmp = 0, oldObj = 0
  try {
    memDc = f.CreateCompatibleDC(screenDc)
    bmp = f.CreateCompatibleBitmap(screenDc, w, h)
    if (!memDc || !bmp) throw new Error('GDI 资源创建失败')
    oldObj = f.SelectObject(memDc, bmp)

    let ok = false
    if (mode === 'bitblt') {
      ok = !!f.BitBlt(memDc, 0, 0, w, h, screenDc, rect.left, rect.top, 0x00cc0020 /* SRCCOPY */)
    } else {
      // PW_RENDERFULLCONTENT(2)：D3D/Unity 窗口必须带这个标志，否则抓到全黑
      ok = !!f.PrintWindow(hwnd, memDc, 2)
      if (!ok) ok = !!f.BitBlt(memDc, 0, 0, w, h, screenDc, rect.left, rect.top, 0x00cc0020)
    }
    if (!ok) throw new Error(`抓帧失败（${mode}）`)

    const bi = {
      bmiHeader: {
        biSize: 40, biWidth: w, biHeight: -h /* 负数 = top-down */, biPlanes: 1, biBitCount: 32,
        biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
      },
      bmiColors: new Uint8Array(4),
    }
    const buf = Buffer.alloc(w * h * 4)
    const lines = f.GetDIBits(memDc, bmp, 0, h, buf, bi, 0)
    if (!lines) throw new Error('GetDIBits 失败')
    return { width: w, height: h, mode, data: buf }
  } finally {
    try {
      if (oldObj) f.SelectObject(memDc, oldObj)
      if (bmp) f.DeleteObject(bmp)
      if (memDc) f.DeleteDC(memDc)
      f.ReleaseDC(0, screenDc)
    } catch { /* 清理失败不掩盖主错误 */ }
  }
}

/* ============================ 输入 ============================ */
const NAMED_VK = {
  Escape: 0x1b, Enter: 0x0d, Tab: 0x09, Space: 0x20, Backspace: 0x08,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27,
  Shift: 0x10, Control: 0x11, Alt: 0x12,
}

/** 键名 → 虚拟键码。'a' / ' ' / 'Escape' 都认 */
function vkOf(key) {
  const { f } = bind()
  if (typeof key === 'number') return key
  const s = String(key)
  if (s in NAMED_VK) return NAMED_VK[s]
  if (s.length === 1) {
    const upper = s.toUpperCase()
    if (/[A-Z0-9]/.test(upper)) return upper.charCodeAt(0)
    // 其它字符走 VkKeyScanW（低字节 = vk，高字节 = shift 状态）
    const scan = f.VkKeyScanW(s.charCodeAt(0))
    if (scan !== -1 && (scan & 0xff) !== 0xff) return scan & 0xff
  }
  const named = Object.keys(NAMED_VK).find((k) => k.toLowerCase() === s.toLowerCase())
  if (named) return NAMED_VK[named]
  throw new Error(`键名认不出来：${key}`)
}

/** 已按下的键（用于 releaseAll 兜底） */
const held = new Set()

function sendKey(vk, up) {
  const { f, INPUTBUF } = bind()
  const b = Buffer.alloc(40)
  b.writeUInt32LE(1, 0)                       // type = INPUT_KEYBOARD
  b.writeUInt16LE(vk, 8)                      // wVk
  b.writeUInt16LE(f.MapVirtualKeyW(vk, 0), 10) // wScan
  b.writeUInt32LE(0x0008 | (up ? 0x0002 : 0), 12) // KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP
  const n = f.SendInput(1, [{ raw: b }], 40)
  if (n !== 1) throw new Error(`SendInput 失败（返回 ${n}）`)
  if (up) held.delete(vk)
  else held.add(vk)
  return true
}

function releaseAll() {
  const out = []
  for (const vk of [...held]) {
    try { sendKey(vk, true); out.push(vk) } catch { /* 尽力而为 */ }
  }
  held.clear()
  return out
}

/**
 * 把游戏窗口所在线程的键盘布局切到英文（00000409）。
 *
 * 🔴 为什么必须做（2026-10-27 实机踩到，查了一个多小时）：
 *   本机只装了 0804（微软拼音），输入法处于**中文模式**时会把字母键和方向键
 *   全部截给候选框，只有 esc / enter 能穿过。表现极具误导性：
 *     - esc 能打开暂停菜单、enter 能选菜单 → 看着像输入完全正常
 *     - 但 a/d 和方向键一动不动 → 看着像「游戏锁了移动」或「SendInput 没落地」
 *   实测切到英文布局后，同一条 SendInput 立刻能走。
 *
 * 返回 { ok, layoutBefore, layoutAfter, switched, alreadyEnglish }；布局用低 16 位语言 ID。
 */
function ensureEnglishInput(hwnd) {
  const { f } = bind()
  const pid = [0]
  const tid = f.GetWindowThreadProcessId(hwnd, pid)
  if (!tid) return { ok: false, error: '取不到窗口线程' }

  const langOf = (hkl) => {
    try {
      return typeof hkl === 'bigint' ? Number(hkl & 0xffffn) : (Number(hkl) & 0xffff)
    } catch { return 0 }
  }

  const before = langOf(f.GetKeyboardLayout(tid))
  if (before === 0x0409) {
    return { ok: true, alreadyEnglish: true, switched: false, layoutBefore: before, layoutAfter: before }
  }

  // KLF_ACTIVATE = 1：没有已安装的 0409 时，这一步会失败，那就如实报失败
  const hkl = f.LoadKeyboardLayoutW('00000409', 1)
  if (!hkl) {
    return { ok: false, error: 'LoadKeyboardLayout(00000409) 失败：系统里没有英文键盘布局', layoutBefore: before }
  }

  const myTid = f.GetCurrentThreadId()
  let attached = false
  try {
    if (tid !== myTid) attached = f.AttachThreadInput(myTid, tid, true)
    f.ActivateKeyboardLayout(hkl, 0)
    // WM_INPUTLANGCHANGEREQUEST：让窗口自己也知道换了输入语言
    f.PostMessageW(hwnd, 0x0050, 0, hkl)
  } finally {
    if (attached) f.AttachThreadInput(myTid, tid, false)
  }

  const after = langOf(f.GetKeyboardLayout(tid))
  return {
    ok: after === 0x0409,
    switched: after !== before,
    layoutBefore: before,
    layoutAfter: after,
    attached,
    error: after === 0x0409 ? undefined : `切完布局还是 0x${after.toString(16)}`,
  }
}

/**
 * 鼠标点击（SendInput MOUSEINPUT）。
 *
 * 🔴 为什么需要它：抢前台只是把窗口放到 z 序最前 + 设了 foreground window，
 * 但 Unity 那种游戏经常**只认真正的鼠标激活**（它靠 WM_ACTIVATE/WM_MOUSEMOVE 判断
 * 「用户真的在操作我」）。实测过：AttachThreadInput 抢到前台后键盘一发不生效，
 * 窗口画面还在动（游戏没死），点一下鼠标之后键盘才正常。
 *
 * 坐标是**窗口客户区**里的像素（调用方给 hwnd 和相对坐标即可）。
 * 用绝对坐标（MOUSEEVENTF_ABSOLUTE）+ 归一化到 0..65535，跨 DPI 更稳。
 */
function click(hwnd, relX, relY) {
  const { f } = bind()
  const r = winRect(hwnd)
  if (!r) return { ok: false, error: '取不到窗口矩形' }
  const cx = r.left + Math.round(relX ?? r.width / 2)
  const cy = r.top + Math.round(relY ?? r.height / 2)
  const sw = Number(f.GetSystemMetrics(0)) || 1920
  const sh = Number(f.GetSystemMetrics(1)) || 1080
  const nx = Math.round((cx * 65535) / Math.max(1, sw - 1))
  const ny = Math.round((cy * 65535) / Math.max(1, sh - 1))

  // 三个事件一次发完：移动 → 按下 → 抬起。跟真人点一下的序列一样。
  const events = [0x0001 | 0x8000, 0x0002 | 0x8000, 0x0004 | 0x8000].map((flags) => {
    const b = Buffer.alloc(40)
    b.writeUInt32LE(0, 0)            // type = INPUT_MOUSE
    b.writeInt32LE(nx, 8)            // dx（绝对坐标，已归一化）
    b.writeInt32LE(ny, 12)           // dy
    b.writeUInt32LE(0, 16)           // mouseData
    b.writeUInt32LE(flags, 20)       // dwFlags
    return { raw: b }
  })
  const n = f.SendInput(3, events, 40)
  return { ok: n === 3, sent: n, at: { x: cx, y: cy } }
}

/**
 * 抢前台。ICEY 是 Unity 无边框窗口，SetForegroundWindow 会被前台锁拒，
 * 必须 AttachThreadInput 到当前前台线程再抢（probe 实测这条能成）。
 *
 * ⚠️ 这里**故意不做** TOPMOST → NOTOPMOST 那套抖动：
 *    一旦 NOTOPMOST 那步没成，ICEY 就永久置顶，把 DSH 整个盖住 ——
 *    用户看到的现象就是「开了艾希之后 DSH 不能用了」。宁可少抢到一次前台，
 *    也不能留下置顶状态（抢失败会被如实报告，让调用方决定怎么办）。
 */
function focus(hwnd) {
  const { f } = bind()
  const fg = Number(f.GetForegroundWindow())
  const myThread = f.GetCurrentThreadId()
  const pidBuf = [0]
  const fgThread = f.GetWindowThreadProcessId(fg, pidBuf)
  const attached = fgThread && fgThread !== myThread ? !!f.AttachThreadInput(myThread, fgThread, true) : false
  let ok = false
  try {
    f.ShowWindow(hwnd, f.IsIconic(hwnd) ? 9 /* SW_RESTORE */ : 5 /* SW_SHOW */)
    f.BringWindowToTop(hwnd)
    ok = !!f.SetForegroundWindow(hwnd)
  } finally {
    if (attached) f.AttachThreadInput(myThread, fgThread, false)
  }
  const now = Number(f.GetForegroundWindow())
  return { requested: ok, foreground: now, isTarget: now === hwnd, attached }
}

/** 当前前台窗口（用来在动作结束后把焦点还回去） */
function getForeground() {
  const { f } = bind()
  const hwnd = Number(f.GetForegroundWindow())
  return { ok: true, hwnd, title: hwnd ? winTitle(hwnd) : '' }
}

/* ============================ 命令分发 ============================ */
const HANDLERS = {
  ping: () => ({
    ok: true,
    koffi: koffiFrom,
    koffiOk: !!koffi,
    pid: process.pid,
    node: process.versions.node,
    electron: process.versions.electron || null,
    platform: process.platform,
  }),

  /** 找 ICEY 窗口 + 状态 */
  find: ({ exe = 'ICEY.exe' } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const w = findIcey(exe)
    if (!w) return { ok: true, found: false, windows: listWindows(exe.replace(/\.exe$/i, '')).slice(0, 8) }
    const { f } = bind()
    return {
      ok: true, found: true, ...w,
      foreground: Number(f.GetForegroundWindow()) === w.hwnd,
    }
  },

  list: ({ filter = '' } = {}) => ({ ok: true, windows: listWindows(filter) }),

  /** 窗口是否还在 */
  alive: ({ hwnd } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const { f } = bind()
    const alive = !!f.IsWindow(hwnd)
    return { ok: true, alive, rect: alive ? winRect(hwnd) : null, title: alive ? winTitle(hwnd) : '', minimized: alive ? !!f.IsIconic(hwnd) : false }
  },

  focus: ({ hwnd } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    return { ok: true, ...focus(hwnd) }
  },

  /**
   * 「激活踢一脚」：补发 WM_ACTIVATEAPP / WM_SETFOCUS。
   * AttachThreadInput 只能让窗口到最前，Unity 有时仍认为「应用没被激活」⇒ 键盘全被吞。
   * 这两个消息是 Unity 判断 Application.isFocused 的依据。
   */
  kick: ({ hwnd } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const { f } = bind()
    const a = f.PostMessageW(hwnd, 0x001C /* WM_ACTIVATEAPP */, 1, 0)
    const b = f.PostMessageW(hwnd, 0x0007 /* WM_SETFOCUS */, 0, 0)
    const c = f.PostMessageW(hwnd, 0x0086 /* WM_NCACTIVATE */, 1, 0)
    return { ok: !!a || !!b || !!c, activateapp: !!a, setfocus: !!b, ncactivate: !!c }
  },

  /** 鼠标点一下（窗口客户区坐标；不传就点窗口中心）。用来让 Unity 真正"激活" */
  click: ({ hwnd, x, y } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    return click(hwnd, x, y)
  },

  getfg: () => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    return getForeground()
  },

  /** 窗口扩展样式（查有没有残留 WS_EX_TOPMOST —— 残留的话游戏会永远盖住 DSH） */
  styles: ({ hwnd } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const { f } = bind()
    const ex = Number(f.GetWindowLongW(hwnd, -20 /* GWL_EXSTYLE */))
    return { ok: true, exStyle: ex, topmost: (ex & 0x8) !== 0, visible: !!f.IsWindowVisible(hwnd) }
  },

  /**
   * 抓帧。format='rgba' 时在**这里**（worker 线程）就完成 BGRA→RGBA 和缩放 ——
   * 这段转换每帧要过 150 万像素，放主线程会跟 DSH 的 UI 抢时间；放 worker 里白送。
   */
  capture: async ({ hwnd, mode = 'printwindow', format = 'rgba', maxWidth = 0 } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const t0 = Date.now()
    const shot = capture(hwnd, mode)
    if (format !== 'rgba') {
      return { ok: true, width: shot.width, height: shot.height, mode, ms: Date.now() - t0, bytes: shot.data.length, data: shot.data }
    }
    const rgba = bgraToRgba(shot.data)
    if (!maxWidth || shot.width <= maxWidth) {
      return { ok: true, width: shot.width, height: shot.height, mode, ms: Date.now() - t0, bytes: rgba.length, data: rgba }
    }
    const out = fitWidth(rgba, shot.width, shot.height, maxWidth)
    return { ok: true, width: out.width, height: out.height, mode, scaledFrom: `${shot.width}x${shot.height}`, ms: Date.now() - t0, bytes: out.data.length, data: out.data }
  },

  keydown: ({ key } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const vk = vkOf(key)
    sendKey(vk, false)
    return { ok: true, vk, key }
  },

  keyup: ({ key } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const vk = vkOf(key)
    sendKey(vk, true)
    return { ok: true, vk, key }
  },

  tap: ({ key, ms = 60 } = {}) => {
    if (!koffi) return { ok: false, error: `koffi 不可用：${koffiFrom}` }
    const vk = vkOf(key)
    sendKey(vk, false)
    return new Promise((resolve) => {
      setTimeout(() => {
        try { sendKey(vk, true); resolve({ ok: true, vk, key, ms }) }
        catch (e) { resolve({ ok: false, error: String(e?.message || e) }) }
      }, ms)
    })
  },

  releaseall: () => ({ ok: true, released: releaseAll() }),

  /** 诊断：这个键现在是不是被系统认为按着 */
  keystate: ({ key } = {}) => {
    const { f } = bind()
    const vk = vkOf(key)
    return { ok: true, vk, down: (f.GetAsyncKeyState(vk) & 0x8000) !== 0 }
  },

  /** 把窗口线程的键盘布局切到英文（中文输入法会吞掉字母键和方向键） */
  englishinput: ({ hwnd } = {}) => ensureEnglishInput(hwnd),
}

async function handle(cmd) {
  const fn = HANDLERS[cmd?.cmd]
  if (!fn) return { ok: false, error: `命令不认识：${cmd?.cmd}（可用 ${Object.keys(HANDLERS).join(' / ')}）` }
  try {
    return await fn(cmd)
  } catch (e) {
    return { ok: false, error: String(e?.message || e), stack: String(e?.stack || '').split('\n').slice(0, 4) }
  }
}

/* ============================ 传输层 ============================ */
// worker 线程：postMessage（ArrayBuffer 可转移）
// 独立进程：JSON Lines（base64 传帧，只用于冒烟测试）

// ⚠️ worker 线程里 parentPort **不是全局**，必须从 node:worker_threads 拿；
//    用 isMainThread 判断才可靠（早先用 globalThis.parentPort 判断，结果 worker 里
//    认成了独立进程，去读 stdin → 读到 EOF → exit(0)，主线程看到 worker 秒退）
const wt = await import('node:worker_threads')
const asWorker = !wt.isMainThread

if (asWorker) {
  const parentPort = wt.parentPort
  parentPort.on('message', async (msg) => {
    const res = await handle(msg)
    if (res && res.data) {
      // 帧数据转移出去，避免拷贝
      const ab = res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.byteLength)
      const { data, ...rest } = res
      parentPort.postMessage({ ...rest, id: msg.id, data: ab }, [ab])
    } else {
      parentPort.postMessage({ ...res, id: msg?.id })
    }
  })
  parentPort.postMessage({ ok: true, ready: true, koffi: koffiFrom, koffiOk: !!koffi })
} else {
  // 独立进程模式（冒烟测试）：逐行读 stdin
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin })
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  write({ ok: true, ready: true, koffi: koffiFrom, koffiOk: !!koffi })
  for await (const line of rl) {
    const text = line.trim()
    if (!text) continue
    let cmd
    try { cmd = JSON.parse(text) } catch { write({ ok: false, error: '不是合法 JSON' }); continue }
    const res = await handle(cmd)
    if (res && res.data) {
      const { data, ...rest } = res
      write({ ...rest, id: cmd.id, b64: data.toString('base64') })
    } else {
      write({ ...res, id: cmd.id })
    }
  }
  process.exit(0)
}

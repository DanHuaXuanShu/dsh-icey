/**
 * probe/act.mjs —— 一体化探针：还原窗口 → 前台 → 按键（可按住）→ 抓帧
 * 用法：node probe/act.mjs <hwnd> <key> [ms] [out.bmp]
 * 全部在**同一个进程**里做完，避免进程之间丢焦点（实测分开跑会 SetForegroundWindow=false）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
  biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
})
// ⚠️ x64 INPUT = 40 字节（type 4 + pad 4 + union 32），KEYBDINPUT 只占 24，必须补 8
const INPUT = koffi.struct('INPUT', { type: 'uint32_t', pad: 'uint32_t', ki: KEYBDINPUT, tail: 'uint8_t[8]' })

const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *b, int m)')
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)')
const IsIconic = user32.func('bool IsIconic(intptr_t h)')
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int cmd)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t h)')
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr_t h)')
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const SetProcessDpiAwarenessContext = user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')
const SendInput = user32.func('uint32_t SendInput(uint32_t n, _In_ INPUT *i, int cb)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t c, uint32_t t)')
const GetDC = user32.func('intptr_t GetDC(intptr_t h)')
const ReleaseDC = user32.func('int ReleaseDC(intptr_t h, intptr_t dc)')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)')
const GetCurrentThreadId = kernel32.func('uint32_t GetCurrentThreadId()')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32_t attach, uint32_t to, bool flag)')
const IsWindow = user32.func('bool IsWindow(intptr_t h)')
const SetWindowPos = user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)')
const PrintWindow = user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32_t f)')
const CreateCompatibleDC = gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)')
const CreateCompatibleBitmap = gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)')
const SelectObject = gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)')
const DeleteObject = gdi32.func('bool DeleteObject(intptr_t o)')
const DeleteDC = gdi32.func('bool DeleteDC(intptr_t dc)')
const GetDIBits = gdi32.func('int GetDIBits(intptr_t dc, intptr_t b, uint32_t s, uint32_t l, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32_t u)')
const GetLastError = kernel32.func('uint32_t GetLastError()')

SetProcessDpiAwarenessContext(-4)

const KEYS = { space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09, up: 0x26, down: 0x28, left: 0x25, right: 0x27, shift: 0x10, ctrl: 0x11 }

function titleOf(h) {
  const b = new Uint16Array(512)
  const n = GetWindowTextW(h, b, 512)
  return Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}

function send(vk, up) {
  const input = { type: 1, pad: 0, ki: { wVk: vk, wScan: MapVirtualKeyW(vk, 0), dwFlags: 0x0008 | (up ? 0x0002 : 0), time: 0, dwExtraInfo: 0 }, tail: new Uint8Array(8) }
  const n = SendInput(1, [input], koffi.sizeof(INPUT))
  return { n, err: n ? 0 : GetLastError() }
}

function capture(hwnd, out) {
  const r = {}
  GetWindowRect(hwnd, r)
  const w = r.right - r.left, h = r.bottom - r.top
  if (w <= 0 || h <= 0) return { error: 'bad rect', r }
  const screen = GetDC(0)
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, w, h)
  const old = SelectObject(mem, bmp)
  const ok = PrintWindow(hwnd, mem, 2)
  const bi = {
    bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 },
    bmiColors: new Uint8Array(4),
  }
  const buf = Buffer.alloc(w * h * 4)
  GetDIBits(mem, bmp, 0, h, buf, bi, 0)
  SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(0, screen)
  let nonBlack = 0
  for (let i = 0; i < buf.length; i += 4) if (buf[i] || buf[i + 1] || buf[i + 2]) nonBlack++
  if (out) {
    const header = Buffer.alloc(54)
    header.write('BM', 0, 'ascii')
    header.writeUInt32LE(54 + buf.length, 2)
    header.writeUInt32LE(54, 10)
    header.writeUInt32LE(40, 14)
    header.writeInt32LE(w, 18)
    header.writeInt32LE(h, 22)
    header.writeUInt16LE(1, 26)
    header.writeUInt16LE(32, 28)
    header.writeUInt32LE(buf.length, 34)
    const flipped = Buffer.alloc(buf.length)
    const stride = w * 4
    for (let y = 0; y < h; y++) buf.copy(flipped, (h - 1 - y) * stride, y * stride, (y + 1) * stride)
    writeFileSync(out, Buffer.concat([header, flipped]))
  }
  return { ok, w, h, nonBlackRatio: +(nonBlack / (w * h)).toFixed(4) }
}

const hwnd = Number(process.argv[2])
const key = process.argv[3] || 'a'
const ms = Number(process.argv[4] || 500)
const out = process.argv[5]
const vk = KEYS[key.toLowerCase()] ?? key.toUpperCase().charCodeAt(0)

// 夺焦点：SetForegroundWindow 会被系统拒绝（前台锁），必须 AttachThreadInput 借前台线程的输入队列
function forceFocus(target) {
  const fgWin = Number(GetForegroundWindow())
  const pidBuf = [0]
  GetWindowThreadProcessId(fgWin, pidBuf)
  const fgThread = GetWindowThreadProcessId(fgWin, pidBuf)
  const myThread = GetCurrentThreadId()
  const attached = fgThread && fgThread !== myThread ? AttachThreadInput(myThread, fgThread, true) : false
  ShowWindow(target, IsIconic(target) ? 9 : 5)
  BringWindowToTop(target)
  const ok = SetForegroundWindow(target)
  const swp = SetWindowPos(target, -1 /* HWND_TOPMOST */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040) // NOSIZE|NOMOVE|SHOWWINDOW
  SetWindowPos(target, -2 /* HWND_NOTOPMOST */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
  if (attached) AttachThreadInput(myThread, fgThread, false)
  return { fgWin, fgThread, myThread, attached, ok, swp }
}

const focusInfo = forceFocus(hwnd)
await new Promise((s) => setTimeout(s, 400))
const fg = Number(GetForegroundWindow())

const before = capture(hwnd, out ? out.replace(/\.bmp$/, '-before.bmp') : null)
const down = send(vk, false)
await new Promise((s) => setTimeout(s, ms))
const up = send(vk, true)
await new Promise((s) => setTimeout(s, 250))
const after = capture(hwnd, out)

console.log(JSON.stringify({ hwnd, title: titleOf(hwnd), vk, ms, focusInfo, fg, focused: fg === hwnd, down, up, before, after }))

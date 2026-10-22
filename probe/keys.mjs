/**
 * probe/keys.mjs —— 试多种按键投递方式，逐个验证画面是否变化
 * 用法：node probe/keys.mjs <hwnd>
 * 对同一个窗口依次试：SendInput(vk) / SendInput(scancode) / PostMessage / SendMessage，
 * 每种之后抓帧比对，输出哪种真的让画面变了。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

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
const INPUT = koffi.struct('INPUT', { type: 'uint32_t', pad: 'uint32_t', ki: KEYBDINPUT, tail: 'uint8_t[8]' })

const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *b, int m)')
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)')
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)')
const GetCurrentThreadId = kernel32.func('uint32_t GetCurrentThreadId()')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32_t a, uint32_t t, bool f)')
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int c)')
const IsIconic = user32.func('bool IsIconic(intptr_t h)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t h)')
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr_t h)')
const SetWindowPos = user32.func('bool SetWindowPos(intptr_t h, intptr_t a, int x, int y, int cx, int cy, uint32_t f)')
const SendInput = user32.func('uint32_t SendInput(uint32_t n, _In_ INPUT *i, int cb)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t c, uint32_t t)')
const PostMessageW = user32.func('bool PostMessageW(intptr_t h, uint32_t msg, uintptr_t w, intptr_t l)')
const SendMessageW = user32.func('intptr_t SendMessageW(intptr_t h, uint32_t msg, uintptr_t w, intptr_t l)')
const GetDC = user32.func('intptr_t GetDC(intptr_t h)')
const ReleaseDC = user32.func('int ReleaseDC(intptr_t h, intptr_t dc)')
const PrintWindow = user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32_t f)')
const SetProcessDpiAwarenessContext = user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')
const CreateCompatibleDC = gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)')
const CreateCompatibleBitmap = gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)')
const SelectObject = gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)')
const DeleteObject = gdi32.func('bool DeleteObject(intptr_t o)')
const DeleteDC = gdi32.func('bool DeleteDC(intptr_t dc)')
const GetDIBits = gdi32.func('int GetDIBits(intptr_t dc, intptr_t b, uint32_t s, uint32_t l, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32_t u)')

SetProcessDpiAwarenessContext(-4)

const WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105, WM_CHAR = 0x0102

function titleOf(h) {
  const b = new Uint16Array(512)
  const n = GetWindowTextW(h, b, 512)
  return Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}

function grab(hwnd) {
  const r = {}
  GetWindowRect(hwnd, r)
  const w = r.right - r.left, h = r.bottom - r.top
  const screen = GetDC(0)
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, w, h)
  const old = SelectObject(mem, bmp)
  PrintWindow(hwnd, mem, 2)
  const bi = {
    bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 },
    bmiColors: new Uint8Array(4),
  }
  const buf = Buffer.alloc(w * h * 4)
  GetDIBits(mem, bmp, 0, h, buf, bi, 0)
  SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(0, screen)
  return { w, h, buf }
}

function hashOf(frame) {
  return createHash('sha1').update(frame.buf).digest('hex').slice(0, 12)
}

function forceFocus(target) {
  const fgWin = Number(GetForegroundWindow())
  const pidBuf = [0]
  const fgThread = GetWindowThreadProcessId(fgWin, pidBuf)
  const myThread = GetCurrentThreadId()
  const attached = fgThread && fgThread !== myThread ? AttachThreadInput(myThread, fgThread, true) : false
  ShowWindow(target, IsIconic(target) ? 9 : 5)
  BringWindowToTop(target)
  SetForegroundWindow(target)
  SetWindowPos(target, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
  SetWindowPos(target, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
  if (attached) AttachThreadInput(myThread, fgThread, false)
}

function siInput(vk, up, scancode) {
  const input = {
    type: 1, pad: 0,
    ki: { wVk: scancode ? 0 : vk, wScan: scancode ? MapVirtualKeyW(vk, 0) : 0, dwFlags: (scancode ? 0x0008 : 0) | (up ? 0x0002 : 0), time: 0, dwExtraInfo: 0 },
    tail: new Uint8Array(8),
  }
  return SendInput(1, [input], koffi.sizeof(INPUT))
}

const hwnd = Number(process.argv[2])
forceFocus(hwnd)
await new Promise((s) => setTimeout(s, 500))

const results = []
const before = grab(hwnd)
results.push({ step: 'baseline', fg: Number(GetForegroundWindow()) === hwnd, hash: hashOf(before) })

async function attempt(name, fn, waitMs = 1200) {
  const b = grab(hwnd)
  fn()
  await new Promise((s) => setTimeout(s, waitMs))
  const a = grab(hwnd)
  results.push({ step: name, changed: hashOf(a) !== hashOf(b), before: hashOf(b), after: hashOf(a) })
  return hashOf(a) !== hashOf(b)
}

// 1) SendInput 带 scancode，按住 120ms
await attempt('SendInput scancode space', () => { siInput(0x20, false, true); setTimeout(() => siInput(0x20, true, true), 120) })
// 2) SendInput 只 vk
await attempt('SendInput vk space', () => { siInput(0x20, false, false); setTimeout(() => siInput(0x20, true, false), 120) })
// 3) PostMessage
await attempt('PostMessage WM_KEYDOWN space', () => { PostMessageW(hwnd, WM_KEYDOWN, 0x20, 0x00390001); setTimeout(() => PostMessageW(hwnd, WM_KEYUP, 0x20, -1073741824), 120) })
// 4) SendMessage
await attempt('SendMessage WM_KEYDOWN space', () => { SendMessageW(hwnd, WM_KEYDOWN, 0x20, 0x00390001); SendMessageW(hwnd, WM_CHAR, 0x20, 0x00390001); SendMessageW(hwnd, WM_KEYUP, 0x20, -1073741824) })

console.log(JSON.stringify({ hwnd, title: titleOf(hwnd), results }, null, 2))

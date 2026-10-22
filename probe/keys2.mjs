/**
 * probe/keys2.mjs —— 分离「画面自己在动」与「输入被接受」
 * 先空等 1.5s 抓两帧（基线），再试各种输入，每步抓帧。
 * 同时试鼠标点击（SendInput 鼠标）。
 * 用法：node probe/keys2.mjs <hwnd> [outPrefix]
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
  biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
})
// x64 INPUT 40 字节：union 最大是 MOUSEINPUT(32)
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32_t', dy: 'int32_t', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
})
const INPUT = koffi.struct('INPUT', { type: 'uint32_t', pad: 'uint32_t', mi: MOUSEINPUT })

const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *b, int m)')
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)')
const GetClientRect = user32.func('bool GetClientRect(intptr_t h, _Out_ RECT *r)')
const ClientToScreen = user32.func('bool ClientToScreen(intptr_t h, _Inout_ POINT *p)')
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

function titleOf(h) {
  const b = new Uint16Array(512)
  const n = GetWindowTextW(h, b, 512)
  return Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}

function grab(hwnd, out) {
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
  return { w, h, buf }
}

const hash = (f) => createHash('sha1').update(f.buf).digest('hex').slice(0, 12)

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

// INPUT 用裸内存手工编码：x64 下 40 字节 = type(4) + pad(4) + union(32)
// 键盘：union 里 KEYBDINPUT = { wVk(u16) wScan(u16) dwFlags(u32) time(u32) dwExtraInfo(uptr) }
// 鼠标：union 里 MOUSEINPUT = { dx(i32) dy(i32) mouseData(u32) dwFlags(u32) time(u32) dwExtraInfo(uptr) }
const INPUTBUF = koffi.struct('INPUTBUF', { raw: 'uint8_t[40]' })

function sendRaw(buf) {
  return SendInput(1, [{ raw: buf }], 40)
}

function key(vk, up) {
  const b = Buffer.alloc(40)
  b.writeUInt32LE(1, 0) // INPUT_KEYBOARD
  b.writeUInt16LE(vk, 8) // wVk
  b.writeUInt16LE(MapVirtualKeyW(vk, 0), 10) // wScan
  b.writeUInt32LE(0x0008 | (up ? 0x0002 : 0), 12) // KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP
  return sendRaw(b)
}

function mouseClick(screenX, screenY, screenW, screenH) {
  const ax = Math.round((screenX * 65535) / (screenW - 1))
  const ay = Math.round((screenY * 65535) / (screenH - 1))
  const mk = (flags) => {
    const b = Buffer.alloc(40)
    b.writeUInt32LE(0, 0) // INPUT_MOUSE
    b.writeInt32LE(ax, 8)
    b.writeInt32LE(ay, 12)
    b.writeUInt32LE(flags, 20)
    return b
  }
  const n1 = sendRaw(mk(0x0001 | 0x8000 | 0x0002)) // MOVE|ABSOLUTE|LEFTDOWN
  const n2 = sendRaw(mk(0x0001 | 0x8000 | 0x0004)) // MOVE|ABSOLUTE|LEFTUP
  return { n1, n2, ax, ay }
}

const hwnd = Number(process.argv[2])
const prefix = process.argv[3] || 'D:\\dsh\\ICEY插件\\shots\\k2'
forceFocus(hwnd)
await new Promise((s) => setTimeout(s, 400))

const log = []
// 基线：不输入，1.5 秒两帧
const a0 = grab(hwnd, prefix + '-00.bmp')
await new Promise((s) => setTimeout(s, 1500))
const a1 = grab(hwnd, prefix + '-01.bmp')
log.push({ step: 'idle-1.5s', changed: hash(a0) !== hash(a1), h0: hash(a0), h1: hash(a1) })

// 各种输入
const tries = [
  ['enter', 0x0D, 150],
  ['space', 0x20, 150],
  ['j', 0x4A, 150],
  ['w', 0x57, 600],
]
let i = 2
for (const [name, vk, holdMs] of tries) {
  const b = grab(hwnd)
  key(vk, false)
  await new Promise((s) => setTimeout(s, holdMs))
  key(vk, true)
  await new Promise((s) => setTimeout(s, 1000))
  const a = grab(hwnd, `${prefix}-${String(i++).padStart(2, '0')}-${name}.bmp`)
  log.push({ step: name, changed: hash(a) !== hash(b), h0: hash(b), h1: hash(a) })
}

// 鼠标点击窗口中心偏下（「按 X 开始」的位置）
const cr = {}
GetClientRect(hwnd, cr)
const pt = { x: Math.floor((cr.right - cr.left) / 2), y: Math.floor((cr.bottom - cr.top) * 0.88) }
ClientToScreen(hwnd, pt)
const b = grab(hwnd)
const click = mouseClick(pt.x, pt.y, 1920, 1200)
await new Promise((s) => setTimeout(s, 1500))
const a = grab(hwnd, prefix + '-99-click.bmp')
log.push({ step: 'mouse-click', click, at: pt, changed: hash(a) !== hash(b), h0: hash(b), h1: hash(a) })

console.log(JSON.stringify({ hwnd, title: titleOf(hwnd), fg: Number(GetForegroundWindow()) === hwnd, log }, null, 2))

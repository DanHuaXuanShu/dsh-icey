/**
 * probe/focus-test.mjs —— 决定性实验：ICEY 在**后台**时 PostMessage 能不能让它响应？
 * 判据用「暂停菜单」：游戏在玩法中时按 Esc 会弹出很显眼的暂停菜单，后台/前台一眼可分。
 *
 * 步骤：
 *   0. 把别的窗口提到前台，确认 ICEY 在后台 → 抓图（应仍是玩法画面）
 *   1. 后台 PostMessage Esc → 抓图（出菜单 = 后台可用；没变 = 后台不可用）
 *   2. 仍然后台，PostMessage Enter/Space 之类 → 抓图
 *   3. 抢前台 + PostMessage Esc → 抓图（出菜单 = 需要前台，但消息路径可用）
 *   4. 抢前台 + SendInput Esc → 抓图（对照组）
 * 用法：node probe/focus-test.mjs <iceyHwnd> <otherHwnd>
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
const INPUTBUF = koffi.struct('INPUTBUF', { raw: 'uint8_t[40]' })

const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)')
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)')
const GetCurrentThreadId = kernel32.func('uint32_t GetCurrentThreadId()')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32_t a, uint32_t t, bool f)')
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int c)')
const IsIconic = user32.func('bool IsIconic(intptr_t h)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t h)')
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr_t h)')
const SendInput = user32.func('uint32_t SendInput(uint32_t n, _In_ INPUTBUF *i, int cb)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t c, uint32_t t)')
const PostMessageW = user32.func('bool PostMessageW(intptr_t h, uint32_t m, uintptr_t w, intptr_t l)')
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

const hwnd = Number(process.argv[2])
const other = Number(process.argv[3] || 0)
const out = 'D:\\dsh\\ICEY插件\\shots'

function grab(name) {
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
  writeFileSync(`${out}\\${name}.bmp`, Buffer.concat([header, flipped]))
  return { w, h }
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
  if (attached) AttachThreadInput(myThread, fgThread, false)
}

const sendRaw = (buf) => SendInput(1, [{ raw: buf }], 40)
function keySend(vk, up) {
  const b = Buffer.alloc(40)
  b.writeUInt32LE(1, 0)
  b.writeUInt16LE(vk, 8)
  b.writeUInt16LE(MapVirtualKeyW(vk, 0), 10)
  b.writeUInt32LE(0x0008 | (up ? 2 : 0), 12)
  return sendRaw(b)
}
function keyPost(vk, up) {
  const scan = MapVirtualKeyW(vk, 0)
  const lp = up ? ((0xC0000000 | (scan << 16) | 1) >>> 0) : ((0x00000001 | (scan << 16)) >>> 0)
  return PostMessageW(hwnd, up ? 0x0101 : 0x0100, vk, lp)
}

const log = []
const ESC = 0x1B

// 0. 后台基线
if (other) forceFocus(other)
await new Promise((s) => setTimeout(s, 800))
grab('ft-00-bg')
log.push({ step: 'bg-baseline', fgIsIcey: Number(GetForegroundWindow()) === hwnd })

// 1. 后台 PostMessage Esc
keyPost(ESC, false); await new Promise((s) => setTimeout(s, 120)); keyPost(ESC, true)
await new Promise((s) => setTimeout(s, 1300))
grab('ft-01-postmsg-esc-bg')
log.push({ step: 'postmsg-esc-background', fgIsIcey: Number(GetForegroundWindow()) === hwnd })

// 2. 抢前台 + PostMessage Esc
forceFocus(hwnd)
await new Promise((s) => setTimeout(s, 900))
grab('ft-02-fg')
log.push({ step: 'fg-baseline', fgIsIcey: Number(GetForegroundWindow()) === hwnd })
keyPost(ESC, false); await new Promise((s) => setTimeout(s, 120)); keyPost(ESC, true)
await new Promise((s) => setTimeout(s, 1300))
grab('ft-03-postmsg-esc-fg')
log.push({ step: 'postmsg-esc-foreground' })

// 3. 前台 SendInput Esc（对照）
keySend(ESC, false); await new Promise((s) => setTimeout(s, 120)); keySend(ESC, true)
await new Promise((s) => setTimeout(s, 1300))
grab('ft-04-sendinput-esc-fg')
log.push({ step: 'sendinput-esc-foreground' })

console.log(JSON.stringify({ hwnd, log }, null, 2))

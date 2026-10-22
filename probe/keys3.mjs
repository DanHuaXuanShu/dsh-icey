/**
 * probe/keys3.mjs —— 单独试「回车开始」，多种编码 × 多次，每次都存图
 * 用法：node probe/keys3.mjs <hwnd>
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
const SendInput = user32.func('uint32_t SendInput(uint32_t n, _In_ INPUTBUF *i, int cb)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t c, uint32_t t)')
const PostMessageW = user32.func('bool PostMessageW(intptr_t h, uint32_t msg, uintptr_t w, intptr_t l)')
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
  SetWindowPos(target, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
  SetWindowPos(target, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
  if (attached) AttachThreadInput(myThread, fgThread, false)
}

const sendRaw = (buf) => SendInput(1, [{ raw: buf }], 40)

/** vkOnly: wVk 填值，不带 SCANCODE；scanOnly: wVk=0 带 SCANCODE；both: 两个都填 */
function keyBuf(vk, up, mode) {
  const b = Buffer.alloc(40)
  b.writeUInt32LE(1, 0)
  const scan = MapVirtualKeyW(vk, 0)
  if (mode === 'vk') { b.writeUInt16LE(vk, 8); b.writeUInt16LE(0, 10); b.writeUInt32LE(up ? 2 : 0, 12) }
  else if (mode === 'scan') { b.writeUInt16LE(0, 8); b.writeUInt16LE(scan, 10); b.writeUInt32LE(0x0008 | (up ? 2 : 0), 12) }
  else { b.writeUInt16LE(vk, 8); b.writeUInt16LE(scan, 10); b.writeUInt32LE(0x0008 | (up ? 2 : 0), 12) }
  return b
}

const hwnd = Number(process.argv[2])
forceFocus(hwnd)
await new Promise((s) => setTimeout(s, 500))

const log = []
const seq = []

// A: vk-only Enter 按住 300ms
seq.push(['A vk-enter 300ms', async () => {
  const d = sendRaw(keyBuf(0x0D, false, 'vk'))
  await new Promise((s) => setTimeout(s, 300))
  const u = sendRaw(keyBuf(0x0D, true, 'vk'))
  return { d, u }
}])
// B: scan-only Enter 按住 300ms
seq.push(['B scan-enter 300ms', async () => {
  const d = sendRaw(keyBuf(0x0D, false, 'scan'))
  await new Promise((s) => setTimeout(s, 300))
  const u = sendRaw(keyBuf(0x0D, true, 'scan'))
  return { d, u }
}])
// C: PostMessage WM_KEYDOWN/UP Enter
seq.push(['C postmsg-enter', async () => {
  const d = PostMessageW(hwnd, 0x0100, 0x0D, 0x001C0001)
  await new Promise((s) => setTimeout(s, 200))
  const u = PostMessageW(hwnd, 0x0101, 0x0D, -1073741824)
  return { d, u }
}])
// D: space via vk, 按住 300ms
seq.push(['D vk-space 300ms', async () => {
  const d = sendRaw(keyBuf(0x20, false, 'vk'))
  await new Promise((s) => setTimeout(s, 300))
  const u = sendRaw(keyBuf(0x20, true, 'vk'))
  return { d, u }
}])

let i = 0
for (const [name, fn] of seq) {
  const out = `D:\\dsh\\ICEY插件\\shots\\k3-${String(i++).padStart(2, '0')}.bmp`
  const r = await fn()
  await new Promise((s) => setTimeout(s, 1500))
  const f = grab(hwnd, out)
  log.push({ step: name, r, fg: Number(GetForegroundWindow()) === hwnd, out, size: `${f.w}x${f.h}` })
}

console.log(JSON.stringify({ hwnd, title: titleOf(hwnd), log }, null, 2))

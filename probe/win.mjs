/**
 * probe/win.mjs —— 窗口操作小工具（探针）
 * 用法：
 *   node probe/win.mjs list [标题子串]        列出顶层窗口
 *   node probe/win.mjs show <hwnd>            还原（最小化→正常）+ 前台
 *   node probe/win.mjs capture <hwnd> <out.bmp>
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

const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
  biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })

const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *b, int m)')
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)')
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr_t h)')
const IsIconic = user32.func('bool IsIconic(intptr_t h)')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)')
const EnumWindows = user32.func('bool EnumWindows(void *cb, intptr_t p)')
// ⚠️ koffi 的回调必须先 proto 声明类型，register 时用 koffi.pointer(PROTO)
const ENUMPROC = koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int cmd)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t h)')
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr_t h)')
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const SetProcessDpiAwarenessContext = user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')
const GetDC = user32.func('intptr_t GetDC(intptr_t h)')
const ReleaseDC = user32.func('int ReleaseDC(intptr_t h, intptr_t dc)')
const PrintWindow = user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32_t flags)')
const CreateCompatibleDC = gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)')
const CreateCompatibleBitmap = gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)')
const SelectObject = gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)')
const BitBlt = gdi32.func('bool BitBlt(intptr_t d, int x, int y, int w, int h, intptr_t s, int sx, int sy, uint32_t rop)')
const DeleteObject = gdi32.func('bool DeleteObject(intptr_t o)')
const DeleteDC = gdi32.func('bool DeleteDC(intptr_t dc)')
const GetDIBits = gdi32.func('int GetDIBits(intptr_t dc, intptr_t b, uint32_t st, uint32_t ln, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32_t u)')

SetProcessDpiAwarenessContext(-4)

function titleOf(h) {
  const b = new Uint16Array(512)
  const n = GetWindowTextW(h, b, 512)
  return Buffer.from(b.buffer, 0, n * 2).toString('utf16le')
}

function listWindows(filter = '') {
  const found = []
  const cb = koffi.register((h) => {
    const t = titleOf(h)
    if (t && t.toLowerCase().includes(filter.toLowerCase())) {
      const r = {}
      GetWindowRect(h, r)
      const pid = [0]
      GetWindowThreadProcessId(h, pid)
      found.push({ hwnd: Number(h), pid: pid[0], title: t, rect: r, visible: IsWindowVisible(h), minimized: IsIconic(h) })
    }
    return true
  }, koffi.pointer(ENUMPROC))
  EnumWindows(cb, 0)
  koffi.unregister(cb)
  return found
}

function capture(hwnd, out, mode = 'printwindow') {
  const r = {}
  GetWindowRect(hwnd, r)
  const w = r.right - r.left
  const h = r.bottom - r.top
  if (w <= 0 || h <= 0) return { error: 'bad rect', r }
  const screen = GetDC(0)
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, w, h)
  const old = SelectObject(mem, bmp)
  let ok
  if (mode === 'bitblt') ok = BitBlt(mem, 0, 0, w, h, screen, r.left, r.top, 0x00CC0020)
  else ok = PrintWindow(hwnd, mem, 2)
  const bi = {
    bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 },
    bmiColors: new Uint8Array(4),
  }
  const buf = Buffer.alloc(w * h * 4)
  const lines = GetDIBits(mem, bmp, 0, h, buf, bi, 0)
  SelectObject(mem, old)
  DeleteObject(bmp)
  DeleteDC(mem)
  ReleaseDC(0, screen)
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
  return { mode, ok, w, h, lines, nonBlackRatio: +(nonBlack / (w * h)).toFixed(4) }
}

const [cmd, a1, a2, a3] = process.argv.slice(2)
if (cmd === 'list') {
  console.log(JSON.stringify(listWindows(a1 || ''), null, 2))
} else if (cmd === 'show') {
  const hwnd = Number(a1)
  const wasMin = IsIconic(hwnd)
  if (wasMin) ShowWindow(hwnd, 9) // SW_RESTORE
  else ShowWindow(hwnd, 5) // SW_SHOW
  await new Promise((s) => setTimeout(s, 500))
  BringWindowToTop(hwnd)
  const fg = SetForegroundWindow(hwnd)
  await new Promise((s) => setTimeout(s, 600))
  console.log(JSON.stringify({ hwnd, wasMin, restored: !IsIconic(hwnd), fg, nowForeground: Number(GetForegroundWindow()), title: titleOf(hwnd) }))
} else if (cmd === 'capture') {
  console.log(JSON.stringify(capture(Number(a1), a2, a3 || 'printwindow')))
} else {
  console.log('usage: list [filter] | show <hwnd> | capture <hwnd> <out> [printwindow|bitblt]')
}

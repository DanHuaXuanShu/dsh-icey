/**
 * probe/capture-probe.mjs —— 可行性探针（不是插件代码）
 * 目标：证明 koffi 能从 profile 解析到，并且能用 GDI 抓任意窗口的像素。
 * 用法：node probe/capture-probe.mjs [hwnd|窗口标题子串]
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

// ⚠️ koffi 要求结构体先注册、再在 func 签名里引用
const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
  biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })

const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t hWnd, _Out_ RECT *rect)')
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr_t hWnd)')
const IsIconic = user32.func('bool IsIconic(intptr_t hWnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *buf, int max)')
const SetProcessDpiAwarenessContext = user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')
const GetDC = user32.func('intptr_t GetDC(intptr_t hWnd)')
const ReleaseDC = user32.func('int ReleaseDC(intptr_t hWnd, intptr_t hDC)')
const PrintWindow = user32.func('bool PrintWindow(intptr_t hWnd, intptr_t hdc, uint32_t flags)')
const GetClientRect = user32.func('bool GetClientRect(intptr_t hWnd, _Out_ RECT *rect)')
const ClientToScreen = user32.func('bool ClientToScreen(intptr_t hWnd, _Inout_ POINT *pt)')

const CreateCompatibleDC = gdi32.func('intptr_t CreateCompatibleDC(intptr_t hdc)')
const CreateCompatibleBitmap = gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t hdc, int w, int h)')
const SelectObject = gdi32.func('intptr_t SelectObject(intptr_t hdc, intptr_t obj)')
const BitBlt = gdi32.func('bool BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32_t rop)')
const DeleteObject = gdi32.func('bool DeleteObject(intptr_t obj)')
const DeleteDC = gdi32.func('bool DeleteDC(intptr_t hdc)')
const GetDIBits = gdi32.func('int GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t lines, _Out_ void *bits, _Inout_ BITMAPINFO *bi, uint32_t usage)')

SetProcessDpiAwarenessContext(-4) // PER_MONITOR_AWARE_V2

const arg = process.argv[2] || ''
let hwnd = 0
if (/^\d+$/.test(arg)) hwnd = Number(arg)
if (!hwnd) hwnd = Number(GetForegroundWindow())

function titleOf(h) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(h, buf, 512)
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

const rect = {}
GetWindowRect(hwnd, rect)
const title = titleOf(hwnd)
const w = rect.right - rect.left
const h = rect.bottom - rect.top
console.log(JSON.stringify({ hwnd, title, rect, visible: IsWindowVisible(hwnd), minimized: IsIconic(hwnd) }, null, 2))
if (w <= 0 || h <= 0) { console.log('bad rect'); process.exit(1) }

const screenDc = GetDC(0)
const memDc = CreateCompatibleDC(screenDc)
const bmp = CreateCompatibleBitmap(screenDc, w, h)
const old = SelectObject(memDc, bmp)

const mode = process.argv[3] || 'printwindow'
let ok
if (mode === 'bitblt') ok = BitBlt(memDc, 0, 0, w, h, screenDc, rect.left, rect.top, 0x00CC0020)
else ok = PrintWindow(hwnd, memDc, 2) // PW_RENDERFULLCONTENT

const bi = {
  bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 },
  bmiColors: new Uint8Array(4),
}
const buf = Buffer.alloc(w * h * 4)
const lines = GetDIBits(memDc, bmp, 0, h, buf, bi, 0)

SelectObject(memDc, old)
DeleteObject(bmp)
DeleteDC(memDc)
ReleaseDC(0, screenDc)

// 非零像素占比（判断是不是黑帧）
let nonBlack = 0
for (let i = 0; i < buf.length; i += 4) if (buf[i] || buf[i + 1] || buf[i + 2]) nonBlack++
console.log(JSON.stringify({ mode, ok, lines, bytes: buf.length, nonBlackRatio: +(nonBlack / (w * h)).toFixed(4) }))

// 写 BMP 方便肉眼看
const header = Buffer.alloc(54)
header.write('BM', 0, 'ascii')
header.writeUInt32LE(54 + buf.length, 2)
header.writeUInt32LE(54, 10)
header.writeUInt32LE(40, 14)
header.writeInt32LE(w, 18)
header.writeInt32LE(h, 22) // 正数 = 自下而上；GetDIBits 用负高度得到自上而下，所以写 BMP 时再翻
header.writeUInt16LE(1, 26)
header.writeUInt16LE(32, 28)
header.writeUInt32LE(buf.length, 34)
// 翻成自下而上
const flipped = Buffer.alloc(buf.length)
const stride = w * 4
for (let y = 0; y < h; y++) buf.copy(flipped, (h - 1 - y) * stride, y * stride, (y + 1) * stride)
writeFileSync(process.argv[4] || join(process.cwd(), 'probe', 'out.bmp'), Buffer.concat([header, flipped]))
console.log('wrote bmp')

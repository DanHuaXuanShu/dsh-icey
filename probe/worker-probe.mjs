/**
 * probe/worker-probe.mjs —— 验证「worker 线程里能不能加载 koffi 并抓帧」
 * 这是决定插件用 worker 还是子进程的关键实验。
 * 用法：node probe/worker-probe.mjs <hwnd>
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hwnd = Number(process.argv[2])

const workerCode = `
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

try {
  const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
  const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
  const koffi = req('koffi')
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')

  const RECT = koffi.struct('WRECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
  const BITMAPINFOHEADER = koffi.struct('WBITMAPINFOHEADER', {
    biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
    biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
    biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
  })
  const BITMAPINFO = koffi.struct('WBITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: 'uint8_t[4]' })

  const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, _Out_ WRECT *r)')
  const GetDC = user32.func('intptr_t GetDC(intptr_t h)')
  const ReleaseDC = user32.func('int ReleaseDC(intptr_t h, intptr_t dc)')
  const PrintWindow = user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32_t f)')
  const CreateCompatibleDC = gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)')
  const CreateCompatibleBitmap = gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)')
  const SelectObject = gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)')
  const DeleteObject = gdi32.func('bool DeleteObject(intptr_t o)')
  const DeleteDC = gdi32.func('bool DeleteDC(intptr_t dc)')
  const GetDIBits = gdi32.func('int GetDIBits(intptr_t dc, intptr_t b, uint32_t s, uint32_t l, _Out_ void *bits, _Inout_ WBITMAPINFO *bi, uint32_t u)')

  const t0 = Date.now()
  const r = {}
  GetWindowRect(workerData.hwnd, r)
  const w = r.right - r.left, h = r.bottom - r.top
  const screen = GetDC(0)
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, w, h)
  const old = SelectObject(mem, bmp)
  const ok = PrintWindow(workerData.hwnd, mem, 2)
  const bi = { bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: w*h*4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: new Uint8Array(4) }
  const buf = Buffer.alloc(w * h * 4)
  GetDIBits(mem, bmp, 0, h, buf, bi, 0)
  SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(0, screen)
  const ms = Date.now() - t0

  // 转成 ArrayBuffer 传回去（structured clone，零拷贝）
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  parentPort.postMessage({ ok: true, w, h, ms, bytes: ab.byteLength, buffer: ab })
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.stack || e) })
}
`

const worker = new Worker(workerCode, { eval: true, workerData: { hwnd } })
worker.on('message', (m) => {
  console.log(JSON.stringify({ ...m, buffer: m.buffer ? `ArrayBuffer(${m.buffer.byteLength})` : undefined }))
  worker.terminate()
})
worker.on('error', (e) => console.log(JSON.stringify({ workerError: String(e && e.stack || e) })))
worker.on('exit', (c) => console.log('worker exit', c))

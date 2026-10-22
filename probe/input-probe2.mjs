/**
 * probe/input-probe2.mjs —— SendInput 可用性（带 GetLastError 诊断）
 * 用法：node probe/input-probe2.mjs [hwnd] [key] [ms]
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
})
// ⚠️ x64 的 INPUT 是 40 字节：type(4) + pad(4) + union{...}(32)。
//    union 里最大的是 MOUSEINPUT（32 字节），KEYBDINPUT 只有 24 —— 必须补齐到 32，
//    否则 cbSize 传 32 会让 SendInput 返回 0 且 GetLastError = 87 (ERROR_INVALID_PARAMETER)。
const INPUT = koffi.struct('INPUT', { type: 'uint32_t', pad: 'uint32_t', ki: KEYBDINPUT, tail: 'uint8_t[8]' })

const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t hWnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *buf, int max)')
const IsWindow = user32.func('bool IsWindow(intptr_t h)')
const SendInput = user32.func('uint32_t SendInput(uint32_t n, _In_ INPUT *inputs, int cb)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t code, uint32_t mapType)')
const GetLastError = kernel32.func('uint32_t GetLastError()')

const KEYS = { space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09, up: 0x26, down: 0x28, left: 0x25, right: 0x27 }

function titleOf(h) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(h, buf, 512)
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

function send(vk, up) {
  const scan = MapVirtualKeyW(vk, 0)
  const input = { type: 1, pad: 0, ki: { wVk: vk, wScan: scan, dwFlags: 0x0008 | (up ? 0x0002 : 0), time: 0, dwExtraInfo: 0 } }
  const n = SendInput(1, [input], koffi.sizeof(INPUT))
  const err = n ? 0 : GetLastError()
  return { n, err }
}

const hwnd = Number(process.argv[2] || GetForegroundWindow())
const key = process.argv[3] || 'a'
const ms = Number(process.argv[4] || 400)
const vk = KEYS[key] ?? key.toUpperCase().charCodeAt(0)

console.log(JSON.stringify({
  inputSize: koffi.sizeof(INPUT), kiSize: koffi.sizeof(KEYBDINPUT),
  hwnd, valid: IsWindow(hwnd), title: titleOf(hwnd), fg: GetForegroundWindow(),
  vk, scan: MapVirtualKeyW(vk, 0),
}))

// 不需要前台也能测 SendInput 是否被接受：先看返回值
const probe = send(vk, false)
send(vk, true)
console.log('send probe:', JSON.stringify(probe))

if (hwnd && GetForegroundWindow() !== hwnd) {
  const r = SetForegroundWindow(hwnd)
  console.log('SetForegroundWindow ->', r, 'fg now', GetForegroundWindow())
  await new Promise((s) => setTimeout(s, 400))
}
const d = send(vk, false)
await new Promise((s) => setTimeout(s, ms))
const u = send(vk, true)
console.log('down', JSON.stringify(d), 'up', JSON.stringify(u))

/**
 * probe/input-probe.mjs —— 可行性探针（不是插件代码）
 * 目标：证明能通过 koffi + SendInput 做**真正的按住**（key down → 等 → key up）。
 * 用法：node probe/input-probe.mjs <hwnd> <key> <ms>
 * 例：  node probe/input-probe.mjs 12345 a 800
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')

// ⚠️ koffi 要求结构体先注册、再在 func 签名里引用
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
})
// x64 下 INPUT = { DWORD type; pad4; union {...} }（union 8 字节对齐 → 偏移 8）
const INPUT = koffi.struct('INPUT', {
  type: 'uint32_t',
  _pad: 'uint32_t',
  ki: KEYBDINPUT,
})

const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t hWnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *buf, int max)')
const SendInput = user32.func('uint32_t SendInput(uint32_t nInputs, _In_ INPUT *inputs, int cbSize)')
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t code, uint32_t mapType)')
const VkKeyScanW = user32.func('int16_t VkKeyScanW(uint16_t ch)')

const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_SCANCODE = 0x0008
const INPUT_KEYBOARD = 1

function titleOf(h) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(h, buf, 512)
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

/** 字符 → 虚拟键码 */
const NAMED = { space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09, shift: 0x10, ctrl: 0x11, alt: 0x12, up: 0x26, down: 0x28, left: 0x25, right: 0x27 }
function vkOf(key) {
  const k = String(key)
  if (NAMED[k.toLowerCase()] !== undefined) return NAMED[k.toLowerCase()]
  if (k.length === 1) {
    const r = VkKeyScanW(k.charCodeAt(0))
    if (r !== -1) return r & 0xff
    const code = k.toUpperCase().charCodeAt(0)
    if (code >= 65 && code <= 90) return code
    if (code >= 48 && code <= 57) return code
  }
  return 0
}

function send(vk, up) {
  const scan = MapVirtualKeyW(vk, 0)
  const input = {
    type: INPUT_KEYBOARD,
    _pad: 0,
    ki: { wVk: vk, wScan: scan, dwFlags: KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 },
  }
  return SendInput(1, [input], koffi.sizeof(INPUT))
}

const hwnd = Number(process.argv[2] || GetForegroundWindow())
const key = process.argv[3] || 'a'
const ms = Number(process.argv[4] || 500)
const vk = vkOf(key)

console.log(JSON.stringify({ hwnd, title: titleOf(hwnd), foreground: GetForegroundWindow(), key, vk, ms, inputSize: koffi.sizeof(INPUT) }))

if (GetForegroundWindow() !== hwnd) {
  const raised = SetForegroundWindow(hwnd)
  console.log(JSON.stringify({ raised, nowForeground: GetForegroundWindow() }))
  await new Promise((r) => setTimeout(r, 350))
}

const downCount = send(vk, false)
const t0 = Date.now()
await new Promise((r) => setTimeout(r, ms))
const upCount = send(vk, true)
console.log(JSON.stringify({ downCount, upCount, heldMs: Date.now() - t0 }))

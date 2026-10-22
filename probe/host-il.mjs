/**
 * probe/host-il.mjs —— 查「DSH 窗口所属进程」的完整性级别
 * 决定插件能不能在宿主进程里直接 SendInput（LOW 会被 UIPI 拦）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')

const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *buf, int max)')
const OpenProcess = kernel32.func('intptr_t OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const CloseHandle = kernel32.func('bool CloseHandle(intptr_t h)')
const OpenProcessToken = advapi32.func('bool OpenProcessToken(intptr_t h, uint32_t access, _Out_ intptr_t *token)')
const GetTokenInformation = advapi32.func('bool GetTokenInformation(intptr_t token, int cls, _Out_ void *info, uint32_t len, _Out_ uint32_t *retLen)')

const IL = { 0x0000: 'UNTRUSTED', 0x1000: 'LOW', 0x2000: 'MEDIUM', 0x2100: 'MEDIUM+', 0x3000: 'HIGH', 0x4000: 'SYSTEM', 0x5000: 'PROTECTED' }

function ilOf(pid) {
  const h = OpenProcess(0x1000, false, pid)
  if (!h) return { pid, error: 'OpenProcess failed' }
  const token = [0]
  if (!OpenProcessToken(h, 0x0008, token)) { CloseHandle(h); return { pid, error: 'token failed' } }
  const buf = Buffer.alloc(128)
  const ret = [0]
  const ok = GetTokenInformation(token[0], 25, buf, 128, ret)
  CloseHandle(h)
  if (!ok) return { pid, error: 'TIL failed' }
  const count = buf[17]
  if (!count) return { pid, error: 'bad sid' }
  const value = buf.readUInt32LE(16 + 8 + (count - 1) * 4)
  return { pid, il: '0x' + value.toString(16), name: IL[value] || '?' }
}

function titleOf(h) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(h, buf, 512)
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

const hwnd = Number(process.argv[2] || GetForegroundWindow())
const pidOut = [0]
GetWindowThreadProcessId(hwnd, pidOut)
console.log(JSON.stringify({ self: process.pid, selfIl: ilOf(process.pid), hwnd, title: titleOf(hwnd), ownerPid: pidOut[0], ownerIl: ilOf(pidOut[0]) }))

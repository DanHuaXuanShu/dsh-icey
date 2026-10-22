/**
 * probe/il-probe.mjs —— 查进程完整性级别（判断 SendInput 会不会被 UIPI 拦）
 * 用法：node probe/il-probe.mjs <pid> [pid...]
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const req = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
const koffi = req('koffi')

const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')

const OpenProcess = kernel32.func('intptr_t OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const CloseHandle = kernel32.func('bool CloseHandle(intptr_t h)')
const OpenProcessToken = advapi32.func('bool OpenProcessToken(intptr_t h, uint32_t access, _Out_ intptr_t *token)')
const GetTokenInformation = advapi32.func('bool GetTokenInformation(intptr_t token, int cls, _Out_ void *info, uint32_t len, _Out_ uint32_t *retLen)')

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TokenIntegrityLevel = 25

const IL = { 0x0000: 'UNTRUSTED', 0x1000: 'LOW', 0x2000: 'MEDIUM', 0x2100: 'MEDIUM+', 0x3000: 'HIGH', 0x4000: 'SYSTEM', 0x5000: 'PROTECTED' }

function ilOf(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!h) return { pid, error: 'OpenProcess failed' }
  const token = [0]
  if (!OpenProcessToken(h, TOKEN_QUERY, token)) { CloseHandle(h); return { pid, error: 'OpenProcessToken failed' } }
  const buf = Buffer.alloc(128)
  const ret = [0]
  const ok = GetTokenInformation(token[0], TokenIntegrityLevel, buf, 128, ret)
  CloseHandle(h)
  if (!ok) return { pid, error: 'GetTokenInformation failed' }
  // TOKEN_MANDATORY_LABEL = { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes } }
  // 64 位：Sid 指针 8 字节 + Attributes 4 字节 + 4 填充 = 16；SID 本身紧跟其后
  // SID: rev(1) count(1) authority(6) subauth[count](4 each)
  const sidOff = 16
  const count = buf[sidOff + 1]
  if (!count) return { pid, error: 'bad sid' }
  const lastOff = sidOff + 8 + (count - 1) * 4
  const value = buf.readUInt32LE(lastOff)
  return { pid, il: value, name: IL[value] || '0x' + value.toString(16) }
}

const pids = process.argv.slice(2).map(Number).filter(Boolean)
if (!pids.length) pids.push(process.pid)
for (const pid of pids) console.log(JSON.stringify(ilOf(pid)))

/**
 * probe/keycap-bench.mjs —— 拿整段真人录像给两种键帽检测器做回归
 *
 * 输入：ffmpeg 导出的原始帧流（-fps 2 -scale 480 -pix_fmt rgba）
 * 输出：每一帧两种检测器的结果，末尾给统计。
 *
 * 用法：node probe/keycap-bench.mjs probe/video/2026-10-26-2205/raw/all.rgba 480 270 2
 */
import { readFileSync } from 'node:fs'
import { findExecuteKeycap } from '../lib/ui/execute-keycap.mjs'
import { findKeycap } from './keycap2.mjs'

const [, , file, wArg, hArg, fpsArg] = process.argv
const width = Number(wArg)
const height = Number(hArg)
const fps = Number(fpsArg || 2)
const buf = readFileSync(file)
const frameBytes = width * height * 4
const total = Math.floor(buf.length / frameBytes)

const rows = []
for (let f = 0; f < total; f++) {
  const rgba = buf.subarray(f * frameBytes, (f + 1) * frameBytes)
  const oldR = findExecuteKeycap(rgba, width, height)
  const newR = findKeycap(rgba, width, height) || { hit: false }
  rows.push({ t: +(f / fps).toFixed(1), old: oldR.hit, oldAt: oldR.hit ? `${oldR.x},${oldR.y}` : '', new: !!newR.hit, newAt: newR.hit ? `${newR.x},${newR.y}` : '', score: newR.score ?? '' })
}

const hitOld = rows.filter((r) => r.old).length
const hitNew = rows.filter((r) => r.new).length
console.log(`共 ${total} 帧（${fps}fps，${(total / fps).toFixed(0)}s）`)
console.log(`旧检测器命中 ${hitOld} 帧，新检测器命中 ${hitNew} 帧`)
console.log('时间 旧 新 新位置 分数')
for (const r of rows) {
  if (r.old || r.new) console.log(`${r.t}s  ${r.old ? '✅' : '·'}  ${r.new ? '✅' : '·'}  ${r.newAt}  ${r.score}`)
}

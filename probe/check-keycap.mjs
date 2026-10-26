/**
 * probe/check-keycap.mjs —— 拿真人录像当「测试用例」跑处决键帽检测
 *
 * 为什么单独写这个：lib/ui/execute-keycap.mjs 的判据是从**上一段**用户录屏
 * （shots/user-video/f0650.png）反推出来的，之后一直只有离线断言，没有第二份真样本。
 * 2026-10-26 用户又录了一段 84 秒的真人游玩，里面至少有 3 处 L 键帽。
 * 拿它当回归样本：命中 ⇒ 判据稳；不命中 ⇒ 我拿到了新的反例可以改。
 *
 * 用法：
 *   ffmpeg -i <video> -ss <t> -frames:v 1 -pix_fmt rgba -f rawvideo <out.rgba> -y
 *   node probe/check-keycap.mjs <out.rgba> <width> <height>
 */
import { readFileSync } from 'node:fs'
import { findExecuteKeycap } from '../lib/ui/execute-keycap.mjs'

const [, , file, wArg, hArg] = process.argv
if (!file) {
  console.error('用法：node probe/check-keycap.mjs <frame.rgba> <width> <height>')
  process.exit(2)
}
const width = Number(wArg)
const height = Number(hArg)
const rgba = readFileSync(file)
if (rgba.length !== width * height * 4) {
  console.error(`尺寸对不上：文件 ${rgba.length} 字节，期望 ${width * height * 4}（${width}x${height})`)
  process.exit(2)
}
const r = findExecuteKeycap(rgba, width, height)
console.log(JSON.stringify({ file, width, height, ...r }, null, 0))

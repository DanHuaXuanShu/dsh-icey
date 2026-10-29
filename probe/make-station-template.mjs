// 从真帧生成强化台模板（照 chest 那套：缩到固定宽灰度，再从缩图上抠模板）。
//
//   node probe/make-station-template.mjs
//
// 为什么要模板而不是颜色阈值：
//   强化台是土金色 + 黑躯干的固定美术资源，而「冰」系敌人、金色机器人、枯叶堆都是土黄，
//   颜色阈值分不开它们（HANDOFF 里那条「金色强化台比金色机器人更像敌人」就是这个坑）。
//   模板匹配看的是整块的明暗结构（猫脸圆盘 + 灰竖板 + 黄黑斜纹），不只是色相。
//
// 素材：probe/fixtures/station-fullframe.png（1568x913，强化台在画面右侧，距离约 1/6 画面宽）
import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const SRC = 'probe/fixtures/station-fullframe.png'
const FRAME_W = 320
// 强化台的归一化框（从放大图目测再换算回来的，见 probe/station-box.mjs 的输出）
const BOX = { x0: 0.637, y0: 0.510, x1: 0.699, y1: 0.646 }

const img = decodePng(fs.readFileSync(SRC))
const { width, height, rgba } = img
const FRAME_H = Math.max(1, Math.round((height * FRAME_W) / width))

// 整帧 → FRAME_W 宽灰度（最近邻抽样，与 chest-match 的 toGray 同法）
const gray = new Float32Array(FRAME_W * FRAME_H)
for (let ty = 0; ty < FRAME_H; ty++) {
  const sy = Math.min(height - 1, Math.floor((ty * height) / FRAME_H))
  for (let tx = 0; tx < FRAME_W; tx++) {
    const sx = Math.min(width - 1, Math.floor((tx * width) / FRAME_W))
    const i = (sy * width + sx) * 4
    gray[ty * FRAME_W + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
  }
}

// 从缩图上抠模板
const tx0 = Math.round(BOX.x0 * FRAME_W)
const tx1 = Math.round(BOX.x1 * FRAME_W)
const ty0 = Math.round(BOX.y0 * FRAME_H)
const ty1 = Math.round(BOX.y1 * FRAME_H)
const tw = tx1 - tx0
const th = ty1 - ty0
console.log(`源 ${width}x${height} → 灰度 ${FRAME_W}x${FRAME_H}`)
console.log(`模板框 ${tx0},${ty0} → ${tx1},${ty1}（${tw}x${th}）`)
if (tw < 8 || th < 8) {
  console.log('⚠️ 模板太小，特征会糊 —— 换更大的 FRAME_W 或放宽 BOX')
}

const tpl = []
for (let y = ty0; y < ty1; y++) {
  for (let x = tx0; x < tx1; x++) tpl.push(Math.round(gray[y * FRAME_W + x]))
}

const out = `/**
 * lib/station-template.mjs —— 强化台（金色四足机器）的灰度模板
 *
 * ⚠️ 自动生成，别手改：node probe/make-station-template.mjs
 * 源帧 probe/fixtures/station-fullframe.png（弥城死镇 496 米，提示框写着「按 ⏎：开启强化」）
 *
 * 模板是「整帧缩到 frameWidth 宽」之后从缩图上抠的，所以匹配时必须用同一缩放。
 */
export const STATION_TEMPLATE = {
  frameWidth: ${FRAME_W},
  width: ${tw},
  height: ${th},
  // ${tw}x${th} 灰度，行优先
  gray: [${tpl.join(',')}],
}
`
const dest = 'lib/station-template.mjs'
fs.writeFileSync(dest, out)
console.log(`已写 ${dest}（${(out.length / 1024).toFixed(1)} KB）`)

// 顺便把模板放大成图，肉眼确认抠对了
const { encodePng } = await import('../lib/png.mjs')
const S = 8
const png = new Uint8Array(tw * S * th * S * 4)
for (let y = 0; y < th * S; y++) {
  for (let x = 0; x < tw * S; x++) {
    const t = tpl[Math.floor(y / S) * tw + Math.floor(x / S)]
    const di = (y * tw * S + x) * 4
    png[di] = t; png[di + 1] = t; png[di + 2] = t; png[di + 3] = 255
  }
}
fs.mkdirSync('shots/station', { recursive: true })
fs.writeFileSync('shots/station/template.png', encodePng(tw * S, th * S, png))
console.log(`模板预览 → shots/station/template.png`)

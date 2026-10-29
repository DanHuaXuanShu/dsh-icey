/**
 * lib/ui/station-match.mjs —— 强化台（金色四足机器）模板匹配
 *
 * 为什么需要它：ICEY 里角色变强的唯一路径是**去强化台花钱升招式**。
 * 插件此前完全不知道强化台在哪 —— 钱一直躺在账户里，招式一直是基础等级。
 * 后果是恶性循环：打不死 → 赚不到钱 → 升不了级 → 更打不死。
 * （2026-10-29 用户 40 分钟录像实测：$169 → $171，净涨 4 块；HANDOFF 里真人 84 秒能涨 24。）
 *
 * 为什么用模板而不是颜色：
 *   强化台是**土金色**，而「冰」系敌人、金色机器人、枯叶堆都是土黄，
 *   颜色阈值分不开（HANDOFF 那条「金色强化台比金色机器人更像敌人」就是这个坑）。
 *   模板匹配看的是整块明暗结构：猫脸圆盘 + 两侧灰竖板 + 黄黑警示斜纹。
 *
 * 做法照 chest-match：整帧缩到 FRAME_W 宽灰度，模板在上面滑窗算 ZNCC，取最高分。
 * 只在画面中下部搜（y 0.30~0.85）—— 强化台站在地上，屏幕上方不会出现，省一半算力。
 */
import { STATION_TEMPLATE } from '../station-template.mjs'

const FRAME_W = STATION_TEMPLATE.frameWidth
/** 只在这个纵向范围里找（归一化）。强化台立在地面上。 */
const SEARCH_Y0 = 0.30
const SEARCH_Y1 = 0.85

function toGray(rgba, width, height) {
  const TH = Math.max(1, Math.round((height * FRAME_W) / width))
  const g = new Float32Array(FRAME_W * TH)
  for (let ty = 0; ty < TH; ty++) {
    const sy = Math.min(height - 1, Math.floor((ty * height) / TH))
    for (let tx = 0; tx < FRAME_W; tx++) {
      const sx = Math.min(width - 1, Math.floor((tx * width) / FRAME_W))
      const i = (sy * width + sx) * 4
      g[ty * FRAME_W + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    }
  }
  return { gray: g, width: FRAME_W, height: TH }
}

// 模板零均值归一化
const TPL = (() => {
  const t = Float32Array.from(STATION_TEMPLATE.gray)
  let mean = 0
  for (const v of t) mean += v
  mean /= t.length
  let varSum = 0
  for (const v of t) varSum += (v - mean) * (v - mean)
  const std = Math.sqrt(varSum / t.length) || 1
  const norm = new Float32Array(t.length)
  for (let i = 0; i < t.length; i++) norm[i] = (t[i] - mean) / std
  return { norm, width: STATION_TEMPLATE.width, height: STATION_TEMPLATE.height }
})()

/**
 * 在帧里找强化台。
 * @returns {{score:number, x:number|null, y:number|null}} score ∈ [-1,1]；x/y 是归一化中心坐标
 */
export function matchStation(rgba, width, height) {
  const { gray, width: GW, height: GH } = toGray(rgba, width, height)
  const tw = TPL.width, th = TPL.height
  const maxX = GW - tw
  const yLo = Math.max(0, Math.floor(SEARCH_Y0 * GH))
  const yHi = Math.min(GH - th, Math.ceil(SEARCH_Y1 * GH))
  let best = { score: -1, x: null, y: null }
  if (maxX < 0 || yHi < yLo) return best

  for (let y = yLo; y <= yHi; y++) {
    for (let x = 0; x <= maxX; x++) {
      // 窗口零均值归一化后与模板做点积（= ZNCC）
      let sum = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) sum += gray[row + tx]
      }
      const n = tw * th
      const mean = sum / n
      let varSum = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) {
          const d = gray[row + tx] - mean
          varSum += d * d
        }
      }
      const std = Math.sqrt(varSum / n)
      if (std < 1) continue   // 纯色块没有结构，不能当匹配
      let dot = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        const trow = ty * tw
        for (let tx = 0; tx < tw; tx++) dot += ((gray[row + tx] - mean) / std) * TPL.norm[trow + tx]
      }
      const score = dot / n
      if (score > best.score) {
        best = {
          score,
          x: (x + tw / 2) / GW,
          y: (y + th / 2) / GH,
        }
      }
    }
  }
  return best
}

/**
 * lib/chest-match.mjs —— 宝箱模板匹配（归一化互相关 NCC）
 *
 * 为什么用模板匹配：宝箱是**固定美术资源**（深色面板 + 青色边框 + 大号青色 $），
 * 而单靠颜色阈值在复杂场景里误报率 59%（深色背景 + 蓝剑 + 粒子都会命中）。
 * 模板来自真实宝箱帧（probe/make-chest-template.mjs 生成 lib/chest-template.mjs）。
 *
 * 做法：把整帧缩到 200 宽灰度图，模板 21×30 在上面滑窗，算零均值归一化互相关（ZNCC），
 * 取最高分。分数 ≥0.55 视为命中（同款宝箱在不同场景下亮度/背景不同，阈值不能太高）。
 */
import { CHEST_TEMPLATE } from './chest-template.mjs'

/** 帧 → 200 宽灰度（最近邻抽样即可，模板本身就是灰度平均出来的） */
function toGray(rgba, width, height) {
  const TW = CHEST_TEMPLATE.frameWidth
  const TH = Math.max(1, Math.round((height * TW) / width))
  const g = new Float32Array(TW * TH)
  for (let ty = 0; ty < TH; ty++) {
    const sy = Math.min(height - 1, Math.floor((ty * height) / TH))
    for (let tx = 0; tx < TW; tx++) {
      const sx = Math.min(width - 1, Math.floor((tx * width) / TW))
      const i = (sy * width + sx) * 4
      g[ty * TW + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    }
  }
  return { gray: g, width: TW, height: TH }
}

const TPL = (() => {
  const { gray, width, height } = CHEST_TEMPLATE
  const t = Float32Array.from(gray)
  let mean = 0
  for (const v of t) mean += v
  mean /= t.length
  let varSum = 0
  for (const v of t) varSum += (v - mean) * (v - mean)
  const std = Math.sqrt(varSum / t.length) || 1
  const norm = new Float32Array(t.length)
  for (let i = 0; i < t.length; i++) norm[i] = (t[i] - mean) / std
  return { norm, width, height, mean, std }
})()

/**
 * 在帧里找宝箱
 * @returns {{score:number, x:number|null, y:number|null}} score ∈ [-1,1]
 */
export function matchChest(rgba, width, height) {
  const { gray, width: GW, height: GH } = toGray(rgba, width, height)
  const tw = TPL.width, th = TPL.height
  if (GW < tw || GH < th) return { score: -1, x: null, y: null }

  let best = -1, bestX = null, bestY = null
  // 只在画面中下部搜（宝箱不会飘在天上）
  const yStart = Math.floor(GH * 0.28)
  for (let y = yStart; y <= GH - th; y += 2) {
    for (let x = 0; x <= GW - tw; x += 2) {
      // 窗口均值/标准差
      let sum = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) sum += gray[row + tx]
      }
      const n = tw * th
      const mean = sum / n
      let vs = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) { const d = gray[row + tx] - mean; vs += d * d }
      }
      const std = Math.sqrt(vs / n) || 1
      // ZNCC
      let corr = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) corr += ((gray[row + tx] - mean) / std) * TPL.norm[ty * tw + tx]
      }
      corr /= n
      if (corr > best) { best = corr; bestX = (x + tw / 2) / GW; bestY = (y + th / 2) / GH }
    }
  }
  return { score: +best.toFixed(3), x: bestX, y: bestY }
}

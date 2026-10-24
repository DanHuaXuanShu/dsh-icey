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
import { CHEST_GLYPH_TEMPLATE } from './chest-template-glyph.mjs'

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

/** 把一张灰度模板做零均值归一化 */
function prep(tpl) {
  const t = Float32Array.from(tpl.gray)
  let mean = 0
  for (const v of t) mean += v
  mean /= t.length
  let varSum = 0
  for (const v of t) varSum += (v - mean) * (v - mean)
  const std = Math.sqrt(varSum / t.length) || 1
  const norm = new Float32Array(t.length)
  for (let i = 0; i < t.length; i++) norm[i] = (t[i] - mean) / std
  return { norm, width: tpl.width, height: tpl.height, name: tpl.name }
}

/**
 * 两类宝箱外观（2026-10-23 用户先后展示）：
 *   ① 实心面板型：深色面板 + 青色边框 + 大号 $（普通/已显示的宝箱）
 *   ② 透明型：箱体半透明，只浮一个青色 ¥ 符号（隐藏房间里常见）
 */
export const CHEST_TEMPLATES = [
  prep({ ...CHEST_TEMPLATE, name: 'panel' }),
  prep({ ...CHEST_GLYPH_TEMPLATE, name: 'glyph' }),
]

/**
 * 在帧里找宝箱
 * @returns {{score:number, x:number|null, y:number|null}} score ∈ [-1,1]
 */
export function matchChest(rgba, width, height) {
  const { gray, width: GW, height: GH } = toGray(rgba, width, height)
  let overall = { score: -1, x: null, y: null, kind: null }
  for (const tpl of CHEST_TEMPLATES) {
    const r = matchOne(gray, GW, GH, tpl)
    if (r.score > overall.score) overall = { ...r, kind: tpl.name }
  }
  return overall
}

/** 单模板匹配 */
function matchOne(gray, GW, GH, TPL) {
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

/* ==================== 透明宝箱（¥ 符号）形状检测 ==================== */

/**
 * 透明宝箱：箱体几乎看不见，只浮一个青色大号 ¥ 符号。
 * 它的背景是满屏青色线条，灰度模板匹配分不开（0.53 vs 背景 0.51），
 * 所以改用**连通块形状**：实测该符号 面积 12298px、长宽比 0.61、填充率 42%，
 * 与背景线条（细长、填充率 100%）和普通特效（面积 <4000）明显不同。
 *
 * 阈值按画面宽度归一化，这样不同分辨率都能用。
 *
 * @returns {{hit:boolean, x:number|null, y:number|null, area:number}}
 */
export function findTransparentChest(rgba, width, height) {
  // 面积按**占画面像素比例**算（不同分辨率都成立）：
  // 实测真符号 12388px / (1606*935) = 0.82%；误报块多在 0.5% 以下且形状不同。
  const totalPx = width * height
  const minArea = totalPx * 0.0060
  const maxArea = totalPx * 0.0130
  const step = width > 900 ? 2 : 1            // 大图降采样，控制开销
  const gw = Math.floor(width / step)
  const gh = Math.floor(height / step)
  const mask = new Uint8Array(gw * gh)

  for (let gy = 0; gy < gh; gy++) {
    const y = gy * step
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * step
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > 110 && b > 150 && g > 130 && r < 150 && b - r > 50) mask[gy * gw + gx] = 1
    }
  }

  const seen = new Uint8Array(gw * gh)
  let best = { hit: false, x: null, y: null, area: 0 }
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const k0 = gy * gw + gx
      if (!mask[k0] || seen[k0]) continue
      const stack = [k0]; seen[k0] = 1
      let area = 0, minX = gx, maxX = gx, minY = gy, maxY = gy
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % gw, cy = (k - cx) / gw
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          const nk = ny * gw + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1
      const areaReal = area * step * step
      if (areaReal < minArea || areaReal > maxArea) continue
      const aspect = bw / bh
      const fill = area / (bw * bh)
      // ¥ 符号实测特征：长宽比 0.61、填充率 42%。收紧到附近，避开剑光/爆发的形状。
      if (aspect < 0.45 || aspect > 0.80) continue
      if (fill < 0.30 || fill > 0.60) continue
      if (areaReal > best.area) {
        best = {
          hit: true,
          x: ((minX + maxX) / 2) / gw,
          y: ((minY + maxY) / 2) / gh,
          area: Math.round(areaReal),
        }
      }
    }
  }
  return best
}
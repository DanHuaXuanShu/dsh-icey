/**
 * lib/guide-arrow.mjs —— 检测画面里的「方向箭头」（游戏给的指引）
 *
 * 真实样本（shots/arrow-now.png，2026-10-23 用户指出）：
 *   一个**暗白色细描边的空心三角**，指向右，约 75×58px（画面宽 1606 时）。
 *   亮度只有 64~114（很暗！），低饱和，所以不能按"亮"去找。
 *
 * 判据：
 *   ① 亮度 70~125、低饱和（灰白）的像素
 *   ② 连通块尺寸占画面宽 3%~7%，长宽比 1.0~1.8，填充率 0.12~0.55（空心）
 *   ③ 朝向：比较左右两端的垂直跨度 —— 底边宽的是"根部"，尖端窄的是"指向"
 */

/** 找出所有候选块，返回最大的一块（没有就 null） */
import { ARROW_TEMPLATE } from './arrow-template.mjs'

/** 模板零均值归一化 */
const ARROW_TPL = (() => {
  const t = Float32Array.from(ARROW_TEMPLATE.gray)
  let mean = 0
  for (const v of t) mean += v
  mean /= t.length
  let vs = 0
  for (const v of t) vs += (v - mean) * (v - mean)
  const std = Math.sqrt(vs / t.length) || 1
  const norm = new Float32Array(t.length)
  for (let i = 0; i < t.length; i++) norm[i] = (t[i] - mean) / std
  return { norm, w: ARROW_TEMPLATE.width, h: ARROW_TEMPLATE.height }
})()

/** 用模板验证一个候选框（把候选缩放到模板尺寸后算 ZNCC） */
function verifyArrow(rgba, width, height, x0, y0, x1, y1) {
  const { norm, w: TW, h: TH } = ARROW_TPL
  const g = new Float32Array(TW * TH)
  for (let ty = 0; ty < TH; ty++) {
    const sy = Math.min(height - 1, y0 + Math.floor((ty * (y1 - y0)) / TH))
    for (let tx = 0; tx < TW; tx++) {
      const sx = Math.min(width - 1, x0 + Math.floor((tx * (x1 - x0)) / TW))
      const i = (sy * width + sx) * 4
      g[ty * TW + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    }
  }
  let mean = 0
  for (const v of g) mean += v
  mean /= g.length
  let vs = 0
  for (const v of g) vs += (v - mean) * (v - mean)
  const std = Math.sqrt(vs / g.length) || 1
  let corr = 0
  for (let i = 0; i < g.length; i++) corr += ((g[i] - mean) / std) * norm[i]
  return corr / g.length
}

export function findGuideArrow(rgba, width, height) {
  const n = width * height
  if (!rgba || rgba.length < n * 4) return { hit: false, dir: null, x: null, y: null }

  const mask = new Uint8Array(n)
  let any = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    if (lum < 70 || lum > 125) continue
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mx === 0) continue
    if ((mx - mn) / mx > 0.22) continue      // 灰白，不是彩色
    mask[p] = 1
    any++
  }
  if (any < 40) return { hit: false, dir: null, x: null, y: null }

  const seen = new Uint8Array(n)
  let best = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k0 = y * width + x
      if (!mask[k0] || seen[k0]) continue
      const stack = [k0]
      seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y
      // 每列/每行的跨度，用来判断朝向
      const colSpan = []
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % width, cy = (k - cx) / width
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        // 八连通：细斜线（三角的斜边）在四连通下会断开，必须用八连通
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx
          if (nx < 0 || nx >= width) continue
          const ny = cy + dy
          if (ny < 0 || ny >= height) continue
          const nk = ny * width + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const wRatio = bw / width
      if (wRatio < 0.03 || wRatio > 0.07) continue
      const aspect = bw / bh
      // 实测真箭头包围盒 60x67（长宽比 0.90），所以下限放到 0.75
      if (aspect < 0.75 || aspect > 1.9) continue
      const fill = area / (bw * bh)
      if (fill < 0.12 || fill > 0.55) continue
      // 朝向：统计最左/最右 25% 宽度里亮像素的垂直跨度
      const bandW = Math.max(1, Math.round(bw * 0.25))
      const spanAt = (x0, x1) => {
        let top = height, bot = -1
        for (let yy = minY; yy <= maxY; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            if (mask[yy * width + xx]) { if (yy < top) top = yy; if (yy > bot) bot = yy }
          }
        }
        return bot >= top ? bot - top + 1 : 0
      }
      const leftSpan = spanAt(minX, minX + bandW)
      const rightSpan = spanAt(maxX - bandW, maxX)
      if (leftSpan === 0 || rightSpan === 0) continue
      // 根部宽、尖端窄 ⇒ 指向另一边
      const dir = leftSpan > rightSpan * 1.35 ? 'right' : (rightSpan > leftSpan * 1.35 ? 'left' : null)
      if (!dir) continue
      // 模板验证：只有形状真的像「空心三角箭头」才接受（排除电线/石头等灰白轮廓）
      const pad = 2
      const corr = verifyArrow(rgba, width, height,
        Math.max(0, minX - pad), Math.max(0, minY - pad),
        Math.min(width - 1, maxX + pad), Math.min(height - 1, maxY + pad))
      if (corr < 0.45) continue
      const score = area * (corr + 1)
      if (!best || score > best.score) {
        best = {
          hit: true,
          dir,
          x: (minX + maxX) / 2 / width,
          y: (minY + maxY) / 2 / height,
          score,
          size: { w: bw, h: bh },
        }
      }
    }
  }
  return best || { hit: false, dir: null, x: null, y: null }
}

/**
 * lib/ui/scan.mjs —— 通用画面扫描原语（**不含任何具体游戏的坐标和阈值**）
 * ============================================================================
 * 这是「界面层」：只提供几个跟游戏无关的像素统计工具。
 * 具体游戏的 HUD 在哪、提示框在哪、什么亮度算亮 —— 都由调用方（比如
 * lib/games/icey/layout.mjs）传进来。
 *
 * 为什么要这一层（2026-10-24）：
 *   原来 analyzeFrame 把「怎么统计」和「ICEY 的坐标/阈值」揉在一个函数里。
 *   结果是换个游戏就得改核心函数、也没法单独测试统计逻辑。
 *   参考 GameScaling 论文的一个观察（interface phase / world phase）：
 *   界面交互那一层是跨游戏通用的，具体世界的知识才是每个游戏各写各的。
 *
 * 采样步长（yStep/xStep/byteStep）是**刻意暴露的参数**：
 *   同一个画面用不同步长算出来的值不一样，所以重构时靠显式传参来保证
 *   「行为完全不变」，而不是靠猜。probe/ab-analyze.mjs 有 A/B 基线守着这件事。
 * ============================================================================
 */

/** 亮度权重（BT.601，跟全项目一致） */
export const LUM_R = 0.299
export const LUM_G = 0.587
export const LUM_B = 0.114

/** 相对坐标的框 {x0,y0,x1,y1}（0~1 比例） */
export function boxToPixels(box, width, height) {
  return {
    x0: Math.floor(width * box.x0),
    x1: Math.floor(width * box.x1),
    y0: Math.floor(height * box.y0),
    y1: Math.floor(height * box.y1),
  }
}

/**
 * 一个区域里的亮度统计。
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {{x0:number,y0:number,x1:number,y1:number}} box 相对坐标
 * @param {{lumMin?:number, yStep?:number, xStep?:number}} opts
 *        lumMin 给定时额外算 brightRatio（亮度 > lumMin 的采样点占比）
 * @returns {{mean:number, brightRatio:number, count:number}}
 */
export function regionStats(rgba, width, height, box, opts = {}) {
  const { lumMin = null, yStep = 2, xStep = 2 } = opts
  const px = boxToPixels(box, width, height)
  let sum = 0
  let bright = 0
  let count = 0
  for (let y = px.y0; y < px.y1; y += yStep) {
    const rowBase = y * width * 4
    for (let x = px.x0; x < px.x1; x += xStep) {
      const i = rowBase + x * 4
      const lum = rgba[i] * LUM_R + rgba[i + 1] * LUM_G + rgba[i + 2] * LUM_B
      sum += lum
      if (lumMin !== null && lum > lumMin) bright++
      count++
    }
  }
  return {
    mean: count ? sum / count : 0,
    brightRatio: count ? bright / count : 0,
    count,
  }
}

/**
 * 全画面「很亮」像素占比（特效强度）。
 * 按字节步长采样：每 byteStep 个字节取一个点（byteStep 必须是 4 的倍数）。
 */
export function globalBrightRatio(rgba, width, height, lumMin, byteStep = 16) {
  const n = width * height * 4
  let bright = 0
  let total = 0
  for (let i = 0; i < n; i += byteStep) {
    const lum = rgba[i] * LUM_R + rgba[i + 1] * LUM_G + rgba[i + 2] * LUM_B
    if (lum > lumMin) bright++
    total++
  }
  return total ? bright / total : 0
}

/**
 * 两帧之间「明显变化」的采样点占比（动作量）。
 * 判定：任一通道差 > threshold 就算变。
 * 步长沿用原来的算法：n/24000 再对齐到 4 的倍数，最少 4。
 */
export function frameDiffRatio(a, b, threshold = 12) {
  const n = Math.min(a.length, b.length)
  const stride = Math.max(4, Math.floor(n / 24000 / 4) * 4)
  let changed = 0
  let total = 0
  for (let i = 0; i < n; i += stride) {
    total++
    if (Math.abs(a[i] - b[i]) > threshold ||
        Math.abs(a[i + 1] - b[i + 1]) > threshold ||
        Math.abs(a[i + 2] - b[i + 2]) > threshold) changed++
  }
  return total ? changed / total : 0
}

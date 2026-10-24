/**
 * lib/execute-keycap.mjs —— 检测「处决提示」的 L 键帽
 *
 * 2026-10-24 从用户录屏里拿到了**真实样本**（之前 593 帧 + 2299 帧都没抓到，
 * 因为一直按「金色环」去找，方向从一开始就错了）。
 *
 * 真实长相（帧 shots/user-video/f0650.png，65.0s）：
 *   **一个近乎正方形的黑色键帽，中间一个白色字母 L**，
 *   悬浮在被打残的怪物上方（跟「⏎ 开启强化」是同一套键帽提示）。
 *   怪物身上那圈「黄」是另一回事（淡金光带，跟怪物糊在一起，不值得当判据）。
 *
 * 实测参数（960 宽画面）：
 *   键帽黑底 bbox ≈ 44 x 40 px（占画面宽 4.6%），接近正方形
 *   黑底很暗（lum ≈ 10~50），实心填充率高
 *   白色 L 的笔画 lum ≈ 240~255，约占键帽内部 10~25%
 *
 * 判据（纯几何，不依赖模板缩放，缩到 480 宽也能用）：
 *   ① 暗块（lum < 62）连通块
 *   ② 宽占比 2.2%~7.5%、长宽比 0.72~1.38（近正方形）
 *   ③ 填充率 > 0.68（实心，不是阴影/树枝那种碎块）
 *   ④ 内部有白色笔画：lum > 185 的像素占内部面积 1.2%~12%
 *
 * 实测校准（f0650 那一帧的真样本）：
 *   暗块 area 1634、bbox 42x44、宽占比 0.044、长宽比 0.95、填充 0.88、
 *   **白笔画占比 0.021** —— 一开始我把门槛设成 ≥0.06，结果一直不命中；
 *   字母 L 的笔画很细，只占键帽面积的 2%。门槛按这个实测值下调。
 */

/** 暗（键帽底） */
const isDark = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114 < 62
/** 白（字母笔画） */
const isWhite = (r, g, b) => {
  const lum = r * 0.299 + g * 0.587 + b * 0.114
  return lum > 185
}

/**
 * @returns {{hit:boolean, x:number|null, y:number|null, score:number, whiteRatio:number}}
 */
export function findExecuteKeycap(rgba, width, height) {
  const n = width * height
  if (!rgba || rgba.length < n * 4) return { hit: false, x: null, y: null, score: 0, whiteRatio: 0 }

  const dark = new Uint8Array(n)
  let darkN = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) { dark[p] = 1; darkN++ }
  }
  // 暗像素太少 ⇒ 画面很亮（过场/白屏），不可能有键帽
  if (darkN < 300) return { hit: false, x: null, y: null, score: 0, whiteRatio: 0 }

  const seen = new Uint8Array(n)
  let best = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k0 = y * width + x
      if (!dark[k0] || seen[k0]) continue
      const stack = [k0]
      seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % width, cy = (k - cx) / width
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const nk = ny * width + nx
          if (dark[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const wRatio = bw / width
      if (wRatio < 0.022 || wRatio > 0.075) continue
      const aspect = bw / bh
      if (aspect < 0.72 || aspect > 1.38) continue
      const fill = area / (bw * bh)
      if (fill < 0.68) continue
      // 内部白笔画（字母 L）
      let white = 0, inner = 0
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          inner++
          const i = (yy * width + xx) * 4
          if (isWhite(rgba[i], rgba[i + 1], rgba[i + 2])) white++
        }
      }
      const whiteRatio = inner ? white / inner : 0
      // 实测：真样本的白笔画占比是 0.021（字母笔画很细）。
      // 一开始设成 ≥0.06，结果一直不命中 —— 按实测下调。
      if (whiteRatio < 0.012 || whiteRatio > 0.12) continue
      // 打分：越大、越方、白笔画越接近实测的 2.5% 越好
      const score = area * (1 - Math.abs(aspect - 1)) * (1 - Math.min(1, Math.abs(whiteRatio - 0.025) * 8))
      if (!best || score > best.score) {
        best = {
          hit: true,
          x: +(((minX + maxX) / 2) / width).toFixed(3),
          y: +(((minY + maxY) / 2) / height).toFixed(3),
          score: +score.toFixed(1),
          whiteRatio: +whiteRatio.toFixed(2),
          // bbox 一并返回：区分字母（L / U / E）要用它内部的精确网格
          bw, bh,
        }
      }
    }
  }
  return best || { hit: false, x: null, y: null, score: 0, whiteRatio: 0 }
}

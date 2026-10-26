/**
 * probe/keycap2.mjs —— 处决键帽检测的第二版（原型，先在录像上验，验过再搬进 lib）
 *
 * 为什么要重写（2026-10-26 真人录像 84s 实测）：
 *   旧版（lib/ui/execute-keycap.mjs）是「找暗连通块」。它有两处硬伤：
 *     ① 暗场景里整屏 93% 都是暗的 ⇒ 键帽和背景连成一块，永远找不到（frame 29s：只剩 1 个 480x270 的巨块）。
 *     ② 480 宽分析分辨率下键帽只有 ~19px，圆角 + 抗锯齿吃掉约 30% 的 bbox ⇒ 填充率掉到 0.64，
 *        被 0.68 的门槛挡掉（frame 39s：唯一形状对得上的候选，只因「不实心」被拒）。
 *   结论：**判据依赖「暗块能独立成块」，这在暗场戏里不成立。**
 *
 * 新版换个出发点：键帽是「一块比周围更暗、内部平坦的圆角方块，里面有个白字」。
 *   - 先按白字找候选（白字是键帽上最不会缺席的东西），
 *   - 再在候选中心开一个边长 ≈ 0.040×宽 的窗口，
 *   - 用**局部对比**判它是键帽本体：本体中位亮度明显低于外圈中位亮度。
 *   局部对比是尺度无关、场景亮度无关的，暗场亮场都能用。
 */

const LUM = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114

function median(arr, len) {
  if (!len) return 0
  const a = Array.prototype.slice.call(arr, 0, len).sort((x, y) => x - y)
  return a[len >> 1]
}

/**
 * @returns {{hit:boolean,x:number|null,y:number|null,score:number,bodyMed:number,ringMed:number,brightFrac:number}|null}
 */
export function findKeycap(rgba, width, height, opts = {}) {
  const sideRatio = opts.sideRatio ?? 0.040
  const S = Math.max(9, Math.round(sideRatio * width))
  const n = width * height
  const lum = new Uint8Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) lum[p] = LUM(rgba[i], rgba[i + 1], rgba[i + 2])

  // ---- ① 白字候选：亮像素连通块，尺寸约键帽的一半 ----
  const bright = (v) => v > 185
  const seen = new Uint8Array(n)
  const cands = []
  const minBx = Math.max(2, Math.round(S * 0.18))
  const maxBx = Math.max(4, Math.round(S * 0.95))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k0 = y * width + x
      if (seen[k0] || !bright(lum[k0])) continue
      const stack = [k0]
      seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y, sum = 0
      while (stack.length) {
        const k = stack.pop()
        area++
        sum += lum[k]
        const cx = k % width, cy = (k - cx) / width
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const nk = ny * width + nx
          if (!seen[nk] && bright(lum[nk])) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (bw < minBx || bh < minBx || bw > maxBx || bh > maxBx) continue
      if (area < 3) continue
      // 字母笔画：填充率不高（L 是折线，不是实心块）
      if (area / (bw * bh) > 0.85) continue
      cands.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, area, bw, bh })
    }
  }
  if (!cands.length) return null

  // ---- ② 局部对比：本体要明显比外圈暗 ----
  const bodyBuf = new Float32Array(S * S)
  const ringBuf = new Float32Array(S * S * 2)
  let best = null
  for (const c of cands) {
    const x0 = Math.round(c.cx - S / 2)
    const y0 = Math.round(c.cy - S / 2)
    if (x0 < 1 || y0 < 1 || x0 + S >= width - 1 || y0 + S >= height - 1) continue
    let bn = 0
    for (let yy = 0; yy < S; yy++) {
      const row = (y0 + yy) * width
      for (let xx = 0; xx < S; xx++) bodyBuf[bn++] = lum[row + x0 + xx]
    }
    const bodyMed = median(bodyBuf, bn)
    // 外圈：从 0.75S 到 1.35S 的方环（只取四条边，够用且省算力）
    let rn = 0
    const r0 = Math.round(S * 0.75)
    const r1 = Math.round(S * 1.35)
    for (let d = r0; d <= r1; d++) {
      for (let t = -r1; t <= r1; t++) {
        for (const [px, py] of [[c.cx + t, c.cy - d], [c.cx + t, c.cy + d], [c.cx - d, c.cy + t], [c.cx + d, c.cy + t]]) {
          const ix = Math.round(px), iy = Math.round(py)
          if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue
          if (rn < ringBuf.length) ringBuf[rn++] = lum[iy * width + ix]
        }
      }
    }
    const ringMed = median(ringBuf, rn)
    if (bodyMed > 62) continue                       // 本体不够暗
    if (bodyMed > ringMed * 0.75) continue           // 不够「比周围暗」
    if (ringMed < 45) continue                        // 周围也黑成一片 ⇒ 判不出（放弃，别瞎猜）
    // 窗口里白色占比要像「一个字母」
    let white = 0
    for (let i = 0; i < bn; i++) if (bodyBuf[i] > 185) white++
    const brightFrac = white / bn
    if (brightFrac < 0.012 || brightFrac > 0.30) continue
    const score = (ringMed - bodyMed) * (1 - Math.min(1, Math.abs(brightFrac - 0.06) * 6))
    if (!best || score > best.score) {
      best = {
        hit: true,
        x: +(c.cx / width).toFixed(3),
        y: +(c.cy / height).toFixed(3),
        score: +score.toFixed(1),
        bodyMed, ringMed, brightFrac: +brightFrac.toFixed(3),
      }
    }
  }
  return best
}

/**
 * lib/execute-prompt.mjs —— 检测「处决提示」：怪物身上的黄圈 + 头顶的 L
 *
 * 用户描述（2026-10-23）：
 *   怪物周围出现**黄圈**、头顶出现 **L** 时，按 L 处决 → 回血、回盾、掉能量结晶。
 *
 * ⚠️ 这套阈值**还没被真实样本校准**（之前 593 帧里没抓到过处决提示，
 *    扫到的黄色块都是伤害数字）。参数按描述设定，等抓到真实画面再调。
 *
 * 判据（两段式，参考宝箱/箭头的经验：先形状、再细节）：
 *   ① 金黄环：金色像素连通块，长宽比 0.7~1.5、填充率低（空心）、尺寸占画面宽 3%~16%
 *   ② 头顶 L：环的上方有一小块很亮的像素团（字母 L）
 */

/** 金色像素 */
function isGold(r, g, b) {
  return r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55
}

/**
 * @returns {{hit:boolean, x:number|null, y:number|null, ringScore:number, hasL:boolean}}
 */
export function findExecutePrompt(rgba, width, height) {
  const n = width * height
  if (!rgba || rgba.length < n * 4) return { hit: false, x: null, y: null, ringScore: 0, hasL: false }

  const gold = new Uint8Array(n)
  let goldCount = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isGold(rgba[i], rgba[i + 1], rgba[i + 2])) { gold[p] = 1; goldCount++ }
  }
  if (goldCount < 80) return { hit: false, x: null, y: null, ringScore: 0, hasL: false }

  const seen = new Uint8Array(n)
  let best = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k0 = y * width + x
      if (!gold[k0] || seen[k0]) continue
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
          if (gold[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const wRatio = bw / width
      if (wRatio < 0.03 || wRatio > 0.16) continue
      const aspect = bw / bh
      if (aspect < 0.7 || aspect > 1.5) continue
      const fill = area / (bw * bh)
      if (fill < 0.12 || fill > 0.62) continue
      // 环要空心：中心 1/3 区域的金色像素应明显少于外圈
      let centerGold = 0, centerN = 0
      const cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2
      const cw = bw / 6, chh = bh / 6
      for (let yy = Math.floor(cym - chh); yy <= Math.ceil(cym + chh); yy++) {
        for (let xx = Math.floor(cxm - cw); xx <= Math.ceil(cxm + cw); xx++) {
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
          centerN++
          if (gold[yy * width + xx]) centerGold++
        }
      }
      const centerRatio = centerN ? centerGold / centerN : 1
      if (centerRatio > 0.55) continue        // 中间也是金色 ⇒ 是实心块/数字，不是环

      // 头顶是否有很亮的字母（L）
      let hasL = false
      const topY0 = Math.max(0, minY - Math.round(bh * 1.6))
      for (let yy = topY0; yy < minY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          const i = (yy * width + xx) * 4
          const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
          if (lum > 200) { hasL = true; break }
        }
        if (hasL) break
      }

      const ringScore = (1 - centerRatio) * area
      if (!best || ringScore > best.ringScore) {
        best = {
          hit: true,
          x: ((minX + maxX) / 2) / width,
          y: ((minY + maxY) / 2) / height,
          ringScore: +ringScore.toFixed(1),
          hasL,
        }
      }
    }
  }
  return best || { hit: false, x: null, y: null, ringScore: 0, hasL: false }
}

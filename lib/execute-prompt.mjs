// ⚠️ 已废弃（2026-10-24）：本文件按「金色环 + 头顶 L」找处决提示，方向从一开始就错了。
// 从用户录屏拿到真样本后确认：处决提示是**黑底白色 L 的键帽图标**，不是金色环。
// 改用 lib/execute-keycap.mjs。这个文件保留只为不破坏旧引用，新代码不要再用它。

/**
 * lib/execute-prompt.mjs —— 检测「处决提示」：怪物身上的黄圈 + 头顶的 L
 *
 * 用户描述（2026-10-23）：
 *   怪物周围出现**黄圈**、头顶出现 **L** 时，按 L 处决 → 回血、回盾、掉能量结晶。
 *
 * ⚠️ 状态：**仍未被真实样本校准**。
 *   2026-10-24 到怪区边打边扫 586 帧（35 秒，16.7 帧/秒）：
 *     · 485 / 586 帧都含金色像素（82%）—— **金色根本不是稀有信号**，
 *       战斗里的刀光火花、伤害数字、爆炸都是金色。
 *     · 现行判据只命中 1 次，而且那次是**假阳性**：
 *       抓到的是艾希刀光的金色火花（x≈0.68 y≈0.72），**没有头顶 L**。
 *   那次命中暴露了真正的问题：`hit` 只看「像环的金色块」，**没要求 hasL**。
 *   用户描述的是两个特征（黄圈 **+** 头顶 L），只用一个当然会被刀光骗。
 *
 * 所以现在：
 *   ① `hit` 必须同时满足「像环」**和**「头顶有 L 亮块」；
 *   ② 「L」的判据从「环上方有一个亮像素（lum>200）」收紧成
 *      「一小块亮像素团（≥10 个、bbox 不超过环宽的 60%）」——
 *      原来的写法任何一个白色像素都能满足，等于没有约束。
 *   ③ 阈值仍然是从「黄圈 + L」这句描述推出来的，不是量出来的。
 *      真要校准，得先抓到一张真实处决提示的截图。
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

      // 头顶是否有**一小块**很亮的像素团（字母 L）
      // ⚠️ 原来写的是「环上方只要有 1 个亮像素（lum>200）就算」——
      //    战斗里到处都是白色高光，这条件等于没约束（实测假阳性就是这么来的）。
      // 现在要求：亮像素 ≥10 个、且这些亮像素的 bbox 宽度不超过环宽的 60%
      //（字母是窄的；星星/火花/高光往往铺得很开）。
      let hasL = false
      {
        const topY0 = Math.max(0, minY - Math.round(bh * 1.6))
        let brightN = 0
        let bMinX = width, bMaxX = 0
        for (let yy = topY0; yy < minY; yy++) {
          for (let xx = Math.max(0, minX - Math.round(bw * 0.4)); xx <= Math.min(width - 1, maxX + Math.round(bw * 0.4)); xx++) {
            const i = (yy * width + xx) * 4
            const lum = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
            if (lum > 200) {
              brightN++
              if (xx < bMinX) bMinX = xx
              if (xx > bMaxX) bMaxX = xx
            }
          }
        }
        const lWidth = brightN ? bMaxX - bMinX + 1 : 0
        hasL = brightN >= 10 && lWidth <= bw * 0.6
      }

      const ringScore = (1 - centerRatio) * area
      // **两个特征都要有**：像环 + 头顶有 L。用户描述的处决提示就是这么两样，
      // 只看其一会被刀光火花骗（2026-10-24 实测：586 帧里假阳性 1 次，正是刀光）。
      if (!hasL) continue
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

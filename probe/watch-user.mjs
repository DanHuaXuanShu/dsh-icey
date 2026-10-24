/**
 * probe/watch-user.mjs —— 用户自己玩，我只在旁边抓帧（**完全不碰键鼠**）
 *
 * ⚠️ 这个探针绝不能：
 *    · 调 focus（会抢走窗口，打断用户操作）
 *    · 发任何按键
 * 只做 PrintWindow 截图 + 分析。
 *
 * 目的：抓到真实的「处决提示」（黄圈 + 头顶 L）样本，
 * 用它去校准 lib/execute-prompt.mjs 的阈值（那个阈值至今没被真实数据验证过）。
 *
 * 判定用**宽松**条件（宁可多存，不可漏）：
 *   金色连通块，面积 ≥25、宽占比 0.02~0.22、长宽比 0.5~2.0、填充 ≤0.8
 * 每命中一次就存帧，同时也记录严格判据的结果，方便对比。
 */
import { NativeBackend } from '../lib/host.mjs'
import { findExecutePrompt } from '../lib/execute-prompt.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 120
const dir = 'shots/user-watch'
mkdirSync(dir, { recursive: true })

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }
console.log(`在抓了：窗口 ${f.hwnd}，${seconds} 秒内只截图不按键。开始打吧。`)

const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async () => {
  for (let k = 0; k < 3; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 800 })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

function isGold(r, g, b) {
  return r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55
}

/** 宽松候选：金色 + 隐约像环 */
function ringCandidates(rgba, W, H) {
  const n = W * H
  const gold = new Uint8Array(n)
  let goldCount = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isGold(rgba[i], rgba[i + 1], rgba[i + 2])) { gold[p] = 1; goldCount++ }
  }
  if (goldCount < 60) return { goldCount, cands: [] }
  const seen = new Uint8Array(n)
  const cands = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k0 = y * W + x
      if (!gold[k0] || seen[k0]) continue
      const stack = [k0]
      seen[k0] = 1
      let area = 0, minX = x, maxX = x, minY = y, maxY = y
      while (stack.length) {
        const k = stack.pop()
        area++
        const cx = k % W, cy = (k - cx) / W
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const nk = ny * W + nx
          if (gold[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1
      const wRatio = bw / W
      const aspect = bw / bh
      const fill = area / (bw * bh)
      if (area < 25) continue
      if (wRatio < 0.02 || wRatio > 0.22) continue
      if (aspect < 0.5 || aspect > 2.0) continue
      if (fill > 0.8) continue
      cands.push({
        area, bw, bh,
        wRatio: +wRatio.toFixed(3),
        aspect: +aspect.toFixed(2),
        fill: +fill.toFixed(2),
        x: +(((minX + maxX) / 2) / W).toFixed(3),
        y: +(((minY + maxY) / 2) / H).toFixed(3),
        minX, maxX, minY, maxY,
      })
    }
  }
  return { goldCount, cands: cands.sort((a, b) => b.area - a.area).slice(0, 3) }
}

const t0 = Date.now()
let frames = 0
let saved = 0
let strictHits = 0
const log = []

while (Date.now() - t0 < seconds * 1000) {
  const c = await grab()
  if (!c) continue
  frames++
  const { goldCount, cands } = ringCandidates(c.data, c.width, c.height)
  const det = findExecutePrompt(c.data, c.width, c.height)
  const at = +((Date.now() - t0) / 1000).toFixed(1)

  if (det.hit) {
    strictHits++
    const p = `${dir}/strict-${String(strictHits).padStart(2, '0')}.png`
    writeFileSync(p, encodePng(c.width, c.height, c.data))
    console.log(`  ⚡ 严格命中 ${at}s → ${p}（ringScore ${det.ringScore} hasL ${det.hasL}）`)
  }
  // 宽松候选：每 1.5 秒最多存一张，避免刷爆磁盘
  if (cands.length && saved < 120) {
    const last = log[log.length - 1]
    if (!last || at - last.at > 1.5) {
      saved++
      const p = `${dir}/cand-${String(saved).padStart(3, '0')}.png`
      writeFileSync(p, encodePng(c.width, c.height, c.data))
      const b = cands[0]
      log.push({ at, file: p, goldCount, cands })
      console.log(`  ▫️ ${at}s 候选 ${p}  金色 ${goldCount}  面积 ${b.area} 宽占比 ${b.wRatio} 长宽比 ${b.aspect} 填充 ${b.fill} 位置(${b.x},${b.y})`)
    }
  }
}

await nb.dispose()
console.log(`\n=== 结束：${frames} 帧，严格命中 ${strictHits}，宽松候选 ${saved} 帧（${dir}/）===`)

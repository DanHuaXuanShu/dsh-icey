/**
 * probe/probe-execute.mjs —— 抓真实的「处决提示」样本
 *
 * 背景：lib/execute-prompt.mjs 的阈值从写完就没被真实样本校准过
 *      （593 张战斗帧里一次都没命中）。现在到怪区，边打边高频抓帧：
 *   ① 记金色像素的数量与最大块的形状（宽占比 / 长宽比 / 填充率 / 中心金色率）
 *   ② 同时跑现成的 findExecutePrompt，看它命不命中
 *   ③ 有任何可疑帧就存下来，供人工核对
 *
 * 这样即使命中不了，也能拿到「真实数据长什么样」，而不是继续猜阈值。
 */
import { NativeBackend } from '../lib/host.mjs'
import { findExecutePrompt } from '../lib/execute-prompt.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 35
const dir = 'shots/execute-probe'
mkdirSync(dir, { recursive: true })

const nb = new NativeBackend()
await nb.start()
const f = await nb.find('ICEY.exe')
if (!f.found) { console.log('没找到 ICEY'); await nb.dispose(); process.exit(1) }

const nonBlack = (d) => {
  let n = 0, tot = 0
  for (let i = 0; i < d.length; i += 4 * 13) {
    if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 12) n++
    tot++
  }
  return tot ? n / tot : 0
}
const grab = async () => {
  for (let k = 0; k < 4; k++) {
    const c = await nb.capture(f.hwnd, 'printwindow', { format: 'rgba', maxWidth: 640 })
    if (c.ok && nonBlack(c.data) >= 0.02) return c
    await new Promise((r) => setTimeout(r, 30))
  }
  return null
}

/** 现行判据：金色像素 */
function isGold(r, g, b) {
  return r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55
}

/** 诊断：金色连通块的形状统计（不套阈值） */
function goldBlocks(rgba, W, H, maxBlocks = 4) {
  const n = W * H
  const gold = new Uint8Array(n)
  let goldCount = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isGold(rgba[i], rgba[i + 1], rgba[i + 2])) { gold[p] = 1; goldCount++ }
  }
  if (!goldCount) return { goldCount: 0, blocks: [] }
  const seen = new Uint8Array(n)
  const blocks = []
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
      blocks.push({
        area, bw, bh,
        wRatio: +(bw / W).toFixed(3),
        aspect: +(bw / bh).toFixed(2),
        fill: +(area / (bw * bh)).toFixed(2),
        x: +(((minX + maxX) / 2) / W).toFixed(2),
        y: +(((minY + maxY) / 2) / H).toFixed(2),
      })
    }
  }
  blocks.sort((a, b) => b.area - a.area)
  return { goldCount, blocks: blocks.slice(0, maxBlocks) }
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 300))

const t0 = Date.now()
let frameNo = 0
let hits = 0
let maxGold = 0
let maxGoldAt = 0
const bestBlocks = []
const goldSeries = []
let attackAt = 0
let saved = 0

console.log(`边打边扫 ${seconds} 秒（每 320ms 攻击一次，尽量快抓帧）…\n`)

while (Date.now() - t0 < seconds * 1000) {
  const elapsed = Date.now() - t0
  // 攻击：用普攻+重击交替，制造伤害
  if (elapsed - attackAt > 320) {
    attackAt = elapsed
    const key = frameNo % 5 === 0 ? 'i' : 'j'
    void nb.keydown(key).then(() => new Promise((r) => setTimeout(r, 90))).then(() => nb.keyup(key)).catch(() => null)
  }

  const c = await grab()
  if (!c) continue
  frameNo++
  const diag = goldBlocks(c.data, c.width, c.height)
  const det = findExecutePrompt(c.data, c.width, c.height)

  if (diag.goldCount > maxGold) {
    maxGold = diag.goldCount
    maxGoldAt = elapsed
    bestBlocks.length = 0
    for (const b of diag.blocks) bestBlocks.push({ ...b, at: elapsed })
  }
  goldSeries.push(diag.goldCount)

  if (det.hit) {
    hits++
    if (saved < 6) {
      writeFileSync(`${dir}/hit-${String(saved + 1).padStart(2, '0')}.png`, encodePng(c.width, c.height, c.data))
      console.log(`  ⚡ ${(elapsed / 1000).toFixed(1)}s 命中：x=${det.x?.toFixed(2)} y=${det.y?.toFixed(2)} ringScore=${det.ringScore} hasL=${det.hasL}`)
      saved++
    }
  }
}

console.log(`\n共 ${frameNo} 帧（${(frameNo / seconds).toFixed(1)} 帧/秒）`)
console.log(`现行判据命中 ${hits} 次`)
const nonZero = goldSeries.filter((v) => v > 0).length
console.log(`有金色像素的帧：${nonZero} / ${frameNo}`)
console.log(`金色像素峰值：${maxGold}（第 ${(maxGoldAt / 1000).toFixed(1)}s）`)
if (bestBlocks.length) {
  console.log('\n峰值那一刻最大的几个金色块：')
  for (const b of bestBlocks) {
    console.log(`  面积 ${String(b.area).padStart(4)}  宽占比 ${b.wRatio}  长宽比 ${b.aspect}  填充 ${b.fill}  位置 (${b.x}, ${b.y})`)
  }
  console.log('\n对照现行判据的门槛：宽占比 0.03~0.16 / 长宽比 0.7~1.5 / 填充 0.12~0.62 / 中心金色 ≤0.55')
}

await nb.releaseAll().catch(() => null)
await nb.dispose()

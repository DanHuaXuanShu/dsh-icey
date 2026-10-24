/**
 * probe/probe-execute2.mjs —— 用连段把怪打残，抓真实处决提示
 *
 * 上一次只按 J/I 单招打了 35 秒，怪没死、也没出现处决提示。
 * 这次改用连段（jjiii 磁阱，实测伤害 103）连续输出，
 * 并且**放宽候选**：只要金色块「隐约像环形」（宽占比 0.02~0.20、长宽比 0.55~1.8）
 * 就存帧 —— 目的是先拿到「真实处决提示长什么样」，而不是继续猜阈值。
 */
import { NativeBackend } from '../lib/host.mjs'
import { findExecutePrompt } from '../lib/execute-prompt.mjs'
import { encodePng } from '../lib/png.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const seconds = Number(process.argv[2]) || 60
const dir = 'shots/execute-cand'
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

function isGold(r, g, b) {
  return r > 165 && g > 125 && b < 115 && r - b > 85 && g - b > 55
}

/** 放宽的候选：金色连通块里有没有「隐约像环」的（宽占比/长宽比放很松） */
function ringCandidates(rgba, W, H) {
  const n = W * H
  const gold = new Uint8Array(n)
  let goldCount = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isGold(rgba[i], rgba[i + 1], rgba[i + 2])) { gold[p] = 1; goldCount++ }
  }
  if (goldCount < 60) return []
  const seen = new Uint8Array(n)
  const out = []
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
      if (wRatio < 0.02 || wRatio > 0.20) continue
      if (aspect < 0.55 || aspect > 1.8) continue
      if (fill > 0.75) continue
      out.push({ area, bw, bh, wRatio: +wRatio.toFixed(3), aspect: +aspect.toFixed(2), fill: +fill.toFixed(2), x: +(((minX + maxX) / 2) / W).toFixed(2), y: +(((minY + maxY) / 2) / H).toFixed(2) })
    }
  }
  return out.sort((a, b) => b.area - a.area).slice(0, 3)
}

await nb.focus(f.hwnd).catch(() => null)
await new Promise((r) => setTimeout(r, 300))

/** 连段 jjiii（磁阱）：快速点 3 个 J + 2 个 I */
async function combo() {
  for (const k of ['j', 'j', 'j', 'i', 'i']) {
    await nb.keydown(k)
    await new Promise((r) => setTimeout(r, 85))
    await nb.keyup(k)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const t0 = Date.now()
let saved = 0
let frames = 0
let strictHits = 0
const candLog = []
let lastCombo = 0

console.log(`连段输出 ${seconds} 秒，放宽候选环形块就存帧…\n`)

while (Date.now() - t0 < seconds * 1000) {
  const elapsed = Date.now() - t0
  // 每 1.3 秒打一套连段
  if (elapsed - lastCombo > 1300) {
    lastCombo = elapsed
    void combo().catch(() => null).then(async () => {
      // 连段收招后再抓几帧看有没有提示
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 120))
        const c = await grab()
        if (!c) continue
        frames++
        const det = findExecutePrompt(c.data, c.width, c.height)
        if (det.hit) {
          strictHits++
          const p = `${dir}/strict-${String(strictHits).padStart(2, '0')}.png`
          writeFileSync(p, encodePng(c.width, c.height, c.data))
          console.log(`  ⚡ ${(elapsed / 1000).toFixed(1)}s 严格判据命中 → ${p}`)
        }
        const cands = ringCandidates(c.data, c.width, c.height)
        if (cands.length && saved < 40) {
          saved++
          const p = `${dir}/cand-${String(saved).padStart(2, '0')}.png`
          writeFileSync(p, encodePng(c.width, c.height, c.data))
          candLog.push({ at: +(elapsed / 1000).toFixed(1), file: p, cands })
        }
      }
    })
  }
  // 主循环也持续扫
  const c = await grab()
  if (c) {
    frames++
    const det = findExecutePrompt(c.data, c.width, c.height)
    if (det.hit) strictHits++
  }
}

await new Promise((r) => setTimeout(r, 1500))
await nb.releaseAll().catch(() => null)

console.log(`\n共扫 ${frames} 帧，严格判据命中 ${strictHits} 次`)
console.log(`存下候选帧 ${candLog.length} 张（在 ${dir}/）`)
if (candLog.length) {
  console.log('\n候选明细（前 12 条）：')
  for (const r of candLog.slice(0, 12)) {
    const b = r.cands[0]
    console.log(`  ${String(r.at).padStart(5)}s  ${r.file.split('/').pop()}  面积 ${b.area}  宽占比 ${b.wRatio}  长宽比 ${b.aspect}  填充 ${b.fill}  位置 (${b.x}, ${b.y})`)
  }
}

await nb.dispose()

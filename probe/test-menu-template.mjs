/**
 * probe/test-menu-template.mjs —— 用「整屏布局模板」识别强化页面
 *
 * 思路（和宝箱模板同一套）：强化页面的**版式固定**（左侧 9 行列表 + 右侧演示窗 + 底部提示），
 * 把整屏缩到 40×23 灰度当模板，在 200 宽的分析帧上滑窗算 ZNCC。
 * 版式一致 ⇒ 分数高；实机画面版式完全不同 ⇒ 分数低。
 */
import { readFileSync } from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'

const FW = 200

function toGray(img) {
  const { width: W, height: H, rgba } = img
  const TH = Math.max(1, Math.round((H * FW) / W))
  const g = new Float32Array(FW * TH)
  for (let ty = 0; ty < TH; ty++) {
    const sy = Math.min(H - 1, Math.floor((ty * H) / TH))
    for (let tx = 0; tx < FW; tx++) {
      const sx = Math.min(W - 1, Math.floor((tx * W) / FW))
      const i = (sy * W + sx) * 4
      g[ty * FW + tx] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    }
  }
  return { gray: g, w: FW, h: TH }
}

/** 从整帧生成模板（缩到 tw×th） */
function makeTemplate(path, tw, th) {
  const img = decodePng(readFileSync(path))
  const { width: W, height: H, rgba } = img
  const t = new Float32Array(tw * th)
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * H) / th), sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * H) / th))
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * W) / tw), sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * W) / tw))
      let s = 0, c = 0
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
        const i = (y * W + x) * 4
        s += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
        c++
      }
      t[ty * tw + tx] = s / Math.max(1, c)
    }
  }
  // 零均值归一化
  let m = 0
  for (const v of t) m += v
  m /= t.length
  let vs = 0
  for (const v of t) vs += (v - m) ** 2
  const sd = Math.sqrt(vs / t.length) || 1
  const norm = new Float32Array(t.length)
  for (let i = 0; i < t.length; i++) norm[i] = (t[i] - m) / sd
  return { norm, tw, th }
}

function score(path, tpl) {
  const img = decodePng(readFileSync(path))
  const { gray, w: GW, h: GH } = toGray(img)
  const { norm, tw, th } = tpl
  if (GW < tw || GH < th) return -1
  let best = -1
  for (let y = 0; y <= GH - th; y += 2) {
    for (let x = 0; x <= GW - tw; x += 2) {
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
      const sd = Math.sqrt(vs / n) || 1
      let corr = 0
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * GW + x
        for (let tx = 0; tx < tw; tx++) corr += ((gray[row + tx] - mean) / sd) * norm[ty * tw + tx]
      }
      corr /= n
      if (corr > best) best = corr
    }
  }
  return best
}

const TW = 40, TH = 23
const tpl = makeTemplate('shots/sk-0-opened.png', TW, TH)
console.log(`模板 ${TW}x${TH}（来自 sk-0-opened.png）\n`)

const menu = ['shots/sk-0-opened.png', 'shots/p3-01.png', 'shots/p3-08.png', 'shots/p3-17.png', 'shots/up-4-upgrade.png', 'shots/mlv-1.png', 'shots/sys-0-menu.png', 'shots/tp-c-system.png']
const play = ['shots/arrow-now.png', 'shots/now-chest.png', 'shots/chest-hidden.png', 'shots/watch/w0101.png', 'shots/combat/c0005.png', 'shots/combat/c0189.png', 'shots/hidden/h8.png', 'shots/f140.png', 'shots/watch/w0254.png']

console.log('=== 菜单类（期望高分）===')
for (const p of menu) {
  try { console.log('  ' + p.split('/').pop().padEnd(22) + score(p, tpl).toFixed(3)) } catch (e) { console.log(p, e.message) }
}
console.log('\n=== 实机画面（期望低分）===')
for (const p of play) {
  try { console.log('  ' + p.split('/').pop().padEnd(22) + score(p, tpl).toFixed(3)) } catch (e) { console.log(p, e.message) }
}

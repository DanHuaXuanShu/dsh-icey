/**
 * probe/keycap-diag.mjs —— 诊断：为什么这张帧没检出处决键帽
 *
 * 直接复用 lib/ui/execute-keycap.mjs 的谓词，把**每个**暗连通块的实测数字都打出来，
 * 再逐条标注它栽在哪一关。这样改门槛时是「看着真样本改」，不是拍脑袋。
 */
import { readFileSync } from 'node:fs'

const [, , file, wArg, hArg] = process.argv
const width = Number(wArg)
const height = Number(hArg)
const rgba = readFileSync(file)

const isDark = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114 < 62
const isWhite = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114 > 185

const n = width * height
const dark = new Uint8Array(n)
let darkN = 0
for (let p = 0, i = 0; p < n; p++, i += 4) {
  if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) { dark[p] = 1; darkN++ }
}
console.log(`暗像素 ${darkN} / ${n} = ${(darkN / n * 100).toFixed(1)}%`)

const seen = new Uint8Array(n)
const comps = []
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
    if (area < 80) continue
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const wRatio = bw / width
    const aspect = bw / bh
    const fill = area / (bw * bh)
    let white = 0, inner = 0
    for (let yy = minY; yy <= maxY; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        inner++
        const i = (yy * width + xx) * 4
        if (isWhite(rgba[i], rgba[i + 1], rgba[i + 2])) white++
      }
    }
    const whiteRatio = inner ? white / inner : 0
    const fails = []
    if (wRatio < 0.022) fails.push('太窄')
    if (wRatio > 0.075) fails.push('太宽')
    if (aspect < 0.72) fails.push('太扁')
    if (aspect > 1.38) fails.push('太高')
    if (fill < 0.68) fails.push('不实心')
    if (whiteRatio < 0.012) fails.push('白笔画太少')
    if (whiteRatio > 0.12) fails.push('白笔画太多')
    comps.push({
      x: +((minX + maxX) / 2 / width).toFixed(3),
      y: +((minY + maxY) / 2 / height).toFixed(3),
      bbox: `${bw}x${bh}`, area, wRatio: +wRatio.toFixed(3), aspect: +aspect.toFixed(2),
      fill: +fill.toFixed(2), whiteRatio: +whiteRatio.toFixed(3),
      pass: fails.length === 0, fails,
    })
  }
}
comps.sort((a, b) => b.area - a.area)
console.log(`连通块（面积≥80）共 ${comps.length} 个，按面积排：`)
for (const c of comps.slice(0, 25)) {
  console.log(`${c.pass ? '✅' : '  '} ${c.bbox} area=${c.area} 位置 ${c.x},${c.y} 宽占比=${c.wRatio} 长宽比=${c.aspect} 填充=${c.fill} 白=${c.whiteRatio}${c.fails.length ? '  ✗ ' + c.fails.join('/') : ''}`)
}

import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
const p = 'C:/Users/m1878/.dsh/attachments/v1/objects/30/3086067ffc454af7e35bff3a0778263471da10ec2b2bc4fb60734a2dae5dc02e'
const im = decodePng(fs.readFileSync(p))
const W = im.width, H = im.height, b = im.rgba
// 血条是青蓝色：蓝和绿都高、红低
const isBar = (i) => { const r=b[i],g=b[i+1],bl=b[i+2]; return bl>110 && g>90 && r<g*0.85 }
const ratio = (x0,y0,x1,y1) => {
  const xa=Math.floor(x0*W), xb=Math.ceil(x1*W), ya=Math.floor(y0*H), yb=Math.ceil(y1*H)
  let n=0, t=0
  for (let y=ya;y<yb;y++) for (let x=xa;x<xb;x++) { t++; const i=(y*W+x)*4; if (isBar(i)) n++ }
  return t ? n/t : 0
}
const cands = [
  ['现在用的 0.097-0.117', 0.075, 0.097, 0.25, 0.117],
  ['收紧 0.106-0.116', 0.075, 0.106, 0.25, 0.116],
  ['收紧 0.1075-0.1155', 0.075, 0.1075, 0.25, 0.1155],
  ['更窄 0.108-0.115', 0.075, 0.108, 0.25, 0.115],
]
for (const [name, x0,y0,x1,y1] of cands) {
  console.log(`  ${name.padEnd(24)} ${(ratio(x0,y0,x1,y1)*100).toFixed(2)}%`)
}
// 逐行明细，看哪几行真是血条
console.log('\n逐行蓝色占比（框 x 0.075-0.25）：')
for (let yy = 0.096; yy <= 0.118; yy += 0.0005) {
  const ya = Math.floor(yy*H), yb = Math.floor((yy+0.0005)*H)
  if (ya === yb) continue
  let n=0,t=0
  for (let y=ya;y<yb;y++) for (let x=Math.floor(0.075*W);x<Math.ceil(0.25*W);x++) { t++; const i=(y*W+x)*4; if (isBar(i)) n++ }
  console.log(`  y=${yy.toFixed(4)}  ${(n/t*100).toFixed(1)}%`)
}

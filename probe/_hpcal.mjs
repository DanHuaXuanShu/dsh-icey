import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
import { HP_BOX, SHIELD_BOX } from '../lib/games/icey/layout.mjs'
const p = 'C:/Users/m1878/.dsh/attachments/v1/objects/30/3086067ffc454af7e35bff3a0778263471da10ec2b2bc4fb60734a2dae5dc02e'
const im = decodePng(fs.readFileSync(p))
const m = analyzeFrame(im.rgba, im.width, im.height, null)
console.log(`图 ${im.width}x${im.height}（满血帧）`)
console.log(`  hp 读数     ${(m.hp*100).toFixed(2)}%`)
console.log(`  shield 读数 ${(m.shield*100).toFixed(2)}%`)
console.log(`  hudBright   ${(m.hudBright*100).toFixed(2)}%`)
// 直接把两个框里的像素铺出来看：血条应该是一整条亮色
const dump = (box, name) => {
  const x0 = Math.floor(box.x0*im.width), x1 = Math.ceil(box.x1*im.width)
  const y0 = Math.floor(box.y0*im.height), y1 = Math.ceil(box.y1*im.height)
  console.log(`\n  ${name} 框 ${x1-x0}x${y1-y0} @ (${x0},${y0})`)
  for (let y = y0; y < y1; y++) {
    let row = ''
    for (let x = x0; x < x1; x++) {
      const i = (y*im.width + x)*4
      const r = im.rgba[i], g = im.rgba[i+1], b = im.rgba[i+2]
      const lum = 0.299*r + 0.587*g + 0.114*b
      row += lum > 140 ? '#' : lum > 60 ? '+' : lum > 25 ? '.' : ' '
    }
    console.log(`   |${row}|`)
  }
}
dump(HP_BOX, 'HP')
dump(SHIELD_BOX, 'SHIELD')

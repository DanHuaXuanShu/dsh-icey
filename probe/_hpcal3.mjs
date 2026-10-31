import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame } from '../lib/autoplay.mjs'
const p = 'C:/Users/m1878/.dsh/attachments/v1/objects/30/3086067ffc454af7e35bff3a0778263471da10ec2b2bc4fb60734a2dae5dc02e'
const im = decodePng(fs.readFileSync(p))
const m = analyzeFrame(im.rgba, im.width, im.height, null)
console.log(`  新框满血读数 hp = ${(m.hp*100).toFixed(2)}%`)
console.log(`  shield = ${(m.shield*100).toFixed(2)}%  hudBright = ${(m.hudBright*100).toFixed(2)}%`)

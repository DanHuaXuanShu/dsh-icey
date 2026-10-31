import fs from 'node:fs'
import { decodePng } from '../lib/png-decode.mjs'
import { analyzeFrame, bossBarFraction } from '../lib/autoplay.mjs'
const p = 'C:/Users/m1878/.dsh/attachments/v1/objects/a5/a53f8bab277c12efceb36c8969d5c9a7c416010dcda7c792035a7f3d3535e5c6'
const im = decodePng(fs.readFileSync(p))
const m = analyzeFrame(im.rgba, im.width, im.height, null)
const show = (k, v) => console.log(`  ${k.padEnd(16)} ${typeof v === 'number' ? (v*100).toFixed(2)+'%' : String(v)}`)
console.log(`暂停画面 ${im.width}x${im.height}`)
show('hudBright', m.hudBright)
show('hp 原始', m.hp)
show('shield 原始', m.shield)
show('combo 连击区', m.combo)
show('promptBright', m.promptBright)
show('subtitle 字幕', m.subtitle)
show('vfx 亮闪', m.vfx)
show('menuRows 红字行', m.menuRows)
const bb = bossBarFraction(im.rgba, im.width, im.height)
console.log(`  bossBar          ${bb === null ? 'null（没血条）' : (bb*100).toFixed(1)+'%'}`)

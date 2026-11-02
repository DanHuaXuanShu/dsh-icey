// 把左上 HUD 裁出来、放大、画上框，做成「有连击 / 无连击」两张对照图。
//
// 为什么要有这个：2026-11-01 那场 91.9 秒战斗的遥测报「连击区全程没亮」，
// 而同一场的画面里明明有黄字、敌人被击倒、钱也 +2。两天里一直没定论的是
// 「到底是框偏了，还是那一帧本来就没有连击数」。
// 答案要靠在**同一块区域**上并排看两帧才判得出来 —— 光看数字（0.000%）判不了。
//
//   node probe/hud-compare.mjs
//
// 产物（进仓库：probe/fixtures/ 在 .gitignore 里有白名单，shots/ 没有）：
//   probe/fixtures/hud-with-combo.png   有「29 连击」+ 进度条，绿框罩得正好
//   probe/fixtures/hud-no-combo.png     同一位置只有背景，绿框里空无一物
//
// 结论（2026-11-02）：读到 0.000% 不等于框坏了。先看画面上有没有连击数字。
//
// 框色：绿 = COMBO_BOX，蓝 = SHIELD_BOX，红 = HP_BOX。
// 源帧：无连击那张是 1280x720 客户区直抓；有连击那张是 960x540 录屏。
// 两帧分辨率不同 —— HUD 按窗口等比缩放已证，所以同一套归一化框在两边都成立。
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../lib/png-decode.mjs'
import { cropRgba, resizeRgba, encodePng } from '../lib/png.mjs'
import { COMBO_BOX, SHIELD_BOX, HP_BOX } from '../lib/games/icey/layout.mjs'

const OUT_DIR = 'probe/fixtures'
const REG = { x0: 0, y0: 0, x1: 0.26, y1: 0.36 } // 覆盖名字 / 血条 / 护盾 / 连击
const Z = 3                                       // 放大倍数：为了看清连击位到底空不空

const CASES = [
  { src: 'shots/user-video/f0273.png', out: 'hud-with-combo.png', note: '有「29 连击」' },
  { src: 'probe/combo/f1-fight.png', out: 'hud-no-combo.png', note: '无连击（91.9 秒那场）' },
]

function hudCrop(file) {
  const { width: W, height: H, rgba } = decodePng(fs.readFileSync(file))
  const x = Math.floor(REG.x0 * W), y = Math.floor(REG.y0 * H)
  const w = Math.ceil((REG.x1 - REG.x0) * W), h = Math.ceil((REG.y1 - REG.y0) * H)
  // 🔴 cropRgba 返回 {data,width,height} 不是裸 Buffer —— 直接把对象当缓冲区传进去
  //    会画出一张全黑图（2026-11-02 踩过，白花了一轮）。
  const c = cropRgba(rgba, W, H, x, y, w, h)
  const bw = c.width * Z, bh = c.height * Z
  const big = resizeRgba(c.data, c.width, c.height, bw, bh)
  for (const { b, col } of [
    { b: COMBO_BOX, col: [0, 255, 80] },
    { b: SHIELD_BOX, col: [60, 140, 255] },
    { b: HP_BOX, col: [255, 60, 60] },
  ]) {
    const bx0 = Math.floor(b.x0 * W - x) * Z, bx1 = Math.floor(b.x1 * W - x) * Z
    const by0 = Math.floor(b.y0 * H - y) * Z, by1 = Math.floor(b.y1 * H - y) * Z
    const put = (px, py) => {
      if (px < 0 || py < 0 || px >= bw || py >= bh) return
      const i = (py * bw + px) * 4
      big[i] = col[0]; big[i + 1] = col[1]; big[i + 2] = col[2]; big[i + 3] = 255
    }
    for (let px = Math.max(0, bx0); px < Math.min(bw, bx1); px++) {
      put(px, by0); put(px, by0 + 1); put(px, by1 - 1); put(px, by1)
    }
    for (let py = Math.max(0, by0); py < Math.min(bh, by1); py++) {
      put(bx0, py); put(bx0 + 1, py); put(bx1 - 1, py); put(bx1, py)
    }
  }
  return { png: encodePng(bw, bh, big), w: bw, h: bh, src: `${W}x${H}` }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
let made = 0
for (const c of CASES) {
  if (!fs.existsSync(c.src)) {
    console.log(`跳过 ${c.out}：源帧 ${c.src} 不在（那两张是本地样本，没进仓库）`)
    continue
  }
  const r = hudCrop(c.src)
  fs.writeFileSync(path.join(OUT_DIR, c.out), r.png)
  console.log(`${path.join(OUT_DIR, c.out)}  ${r.w}x${r.h}  ← ${c.src} (${r.src})  ${c.note}`)
  made++
}
console.log(`\nCOMBO_BOX ${JSON.stringify(COMBO_BOX)}`)
console.log(made ? `做好 ${made} 张。绿框里有连击数字 = 框对；绿框里是纯背景 = 那一帧本来就没有连击。`
                 : '一张都没做：源帧都不在，需要先跑一次 icey_look / 录屏把它们抓回来。')

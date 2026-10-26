/**
 * probe/enemy-detect/detect.mjs —— 画面内敌人检测（纯函数，无依赖，无副作用）
 * ============================================================================
 * 要解决什么：
 *   决策层原来只有 `enemyDir`（黄色实心箭头）和 `executeX`（处决提示）两个替代品，
 *   而它们分别只在「敌人出画」和「处决瞬间」存在。真打起来时战斗分支一直朝右挥刀，
 *   敌人在身后就白打。这个模块补上「画面内敌人在左还是右」。
 *
 * 输入只有一帧：{ rgba, width, height }。不碰文件/网络/计时器，可以被
 * lib/autoplay.mjs 一行 import。所有判据都用归一化坐标，不假设分辨率。
 *
 * ★ 判据和它的实测依据（数字全在 REPORT.md）：
 *   1) 玩家 = 画面里那一簇**青色能量光**（艾希的围巾/腿/剑光）。全项目已在用这个事实
 *      （probe/track-hero.mjs）。三个坑，全部实测踩过：
 *        · 竞技场两端的**战斗屏障也是青色**，竖直贯穿 → 贴边列不看、按形状排掉；
 *        · 她的**剑光/大招也是青色**，而且比本人亮得多、大得多 → 找「矮而像人」的块；
 *        · 画面下沿中间那条**黄色能量槽**是全画面最稳定的暖色源（每一帧都有，
 *          连纯黑过场帧都有），必须先排除再谈敌人。
 *   2) 敌人 = 动作带里一条**又宽又密的暖色发光带**。ICEY 的怪形态各异（坦克机器人、
 *      浮游炮、蜘蛛雷），但都有一堆金色/琥珀/红色发光件；背景是冷灰水泥墙与路面，
 *      暖色密度低一个数量级。
 *   3) side = 敌人带中心 相对 玩家 x 的左右。
 *
 * ★ 这个检测器的定位：**保守**。宁可返回 null（交给 chase/黄色箭头兜底），
 *   也不要给一个反方向。REPORT.md 里有正/负样本的实测命中率与误报率。
 * ============================================================================
 */

const LUM_R = 0.299
const LUM_G = 0.587
const LUM_B = 0.114

/**
 * 排除区（归一化坐标），都是实测确认过「一定不是敌人」的地方：
 *   - 标题栏 + 顶部 HUD（血/盾/钱）
 *   - 左下连击数（黄色，是本检测最强的假阳性源）
 *   - 画面下沿中间那条**黄色能量槽**（y≈0.87，每帧固定，14.8% 的列密度！）
 *   - 底部字幕条
 */
const EXCLUDE_BOXES = [
  { x0: 0.00, y0: 0.000, x1: 1.00, y1: 0.125 }, // 标题栏 + HUD 上沿
  { x0: 0.00, y0: 0.125, x1: 0.215, y1: 0.345 }, // 血条/护盾/连击数（黄！）
  { x0: 0.800, y0: 0.000, x1: 1.00, y1: 0.185 }, // 右上金钱
  { x0: 0.395, y0: 0.830, x1: 0.605, y1: 0.920 }, // 下沿中间的黄色能量槽
  { x0: 0.00, y0: 0.930, x1: 1.00, y1: 1.000 }, // 底部字幕条
]

/** 贴边保护带：画面左右各 5% 不看（战斗屏障是一整条青色/暖色光矛） */
const EDGE_GUARD = 0.05

/** 动作带：敌人站着/漂浮的高度区间（归一化 y） */
const BAND_Y0 = 0.18
const BAND_Y1 = 0.93

/** 内部网格列数，跟分辨率解耦 */
const GRID_COLS = 120

/** 暖色发光像素判据（琥珀/金/橙/红）。标定见 REPORT.md。 */
function isWarmGlow(r, g, b, lum) {
  if (lum < 62) return false // 太暗的暖色不是发光件
  if (r - b < 28) return false // 蓝分量不够低 → 不是暖色
  if (r < 72) return false
  if (b > 150) return false // 亮蓝/青（玩家、屏障）
  if (g - b > 120) return false // 荧光绿
  return true
}

/** 青色能量光判据。比 probe/track-hero.mjs 收紧一档，用来排掉银灰金属和淡青光。 */
function isCyanGlow(r, g, b, lum) {
  return lum > 130 && b > 175 && g > 150 && r < 155 && b - r > 65 && b - g < 60
}

function inAnyBox(x, y) {
  for (let i = 0; i < EXCLUDE_BOXES.length; i++) {
    const b = EXCLUDE_BOXES[i]
    if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) return true
  }
  return false
}

/** 压缩成 GRID_COLS 宽网格，统计青色/暖色占比 */
function gridStats(rgba, width, height) {
  const cell = width / GRID_COLS
  const gw = GRID_COLS
  const gh = Math.max(1, Math.round(height / cell))
  const cyan = new Float32Array(gw * gh)
  const warm = new Float32Array(gw * gh)
  const tot = new Float32Array(gw * gh)
  let cyanPx = 0
  let allPx = 0
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / (height / gh)))
    const ny = (y + 0.5) / height
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) / width
      if (nx < EDGE_GUARD || nx > 1 - EDGE_GUARD || inAnyBox(nx, ny)) continue
      const i = row + x * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      const gx = Math.min(gw - 1, Math.floor(x / cell))
      const k = gy * gw + gx
      tot[k]++
      allPx++
      const L = r * LUM_R + g * LUM_G + b * LUM_B
      if (isCyanGlow(r, g, b, L)) { cyan[k]++; cyanPx++ }
      if (ny >= BAND_Y0 && ny <= BAND_Y1 && isWarmGlow(r, g, b, L)) warm[k]++
    }
  }
  for (let k = 0; k < gw * gh; k++) {
    if (tot[k] > 0) { cyan[k] /= tot[k]; warm[k] /= tot[k] }
  }
  return { gw, gh, cyan, warm, cyanFrac: allPx ? cyanPx / allPx : 0 }
}

/** 玩家定位：青色连通块里挑「矮、不太宽、贴地、块大」的那一块；落点取块体下半部质心 */
function locatePlayer(gw, gh, cyan) {
  const mask = new Uint8Array(gw * gh)
  for (let k = 0; k < gw * gh; k++) if (cyan[k] >= 0.08) mask[k] = 1
  const seen = new Uint8Array(gw * gh)
  const stack = []
  let best = null
  for (let k = 0; k < gw * gh; k++) {
    if (!mask[k] || seen[k]) continue
    stack.length = 0
    stack.push(k)
    seen[k] = 1
    let n = 0, sx = 0, sy = 0
    let x0 = gw, x1 = -1, y0 = gh, y1 = -1
    const cells = []
    while (stack.length) {
      const q = stack.pop()
      const qy = (q / gw) | 0, qx = q % gw
      n++; sx += qx; sy += qy; cells.push(q)
      if (qx < x0) x0 = qx
      if (qx > x1) x1 = qx
      if (qy < y0) y0 = qy
      if (qy > y1) y1 = qy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = qx + dx, ny = qy + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          const nk = ny * gw + nx
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
        }
      }
    }
    if (n < 4) continue
    const wF = (x1 - x0 + 1) / gw
    const hF = (y1 - y0 + 1) / gh
    if (hF > 0.55) continue // 竖直屏障
    if (wF > 0.24) continue // 横向剑光/大招长条
    if (hF < 0.05) continue
    const cy = sy / n / gh
    const score = Math.log2(1 + n) * (0.55 + 0.75 * cy)
    if (best && score <= best.score) continue
    let lx = 0, ln = 0
    const lowCut = y1 - 0.45 * (y1 - y0)
    for (const q of cells) if (((q / gw) | 0) >= lowCut) { lx += q % gw; ln++ }
    best = { score, x: (ln ? lx / ln : sx / n) / gw, y: cy, n, wF, hF }
  }
  return best
}

/** 逐列暖色密度 + 每列暖色像素的纵向范围 */
function warmColumns(gw, gh, warm) {
  const dens = new Float32Array(gw)
  const yMin = new Float32Array(gw).fill(1)
  const yMax = new Float32Array(gw).fill(0)
  for (let gy = 0; gy < gh; gy++) {
    const ny = (gy + 0.5) / gh
    for (let gx = 0; gx < gw; gx++) {
      const v = warm[gy * gw + gx]
      if (v <= 0) continue
      dens[gx] += v
      if (ny < yMin[gx]) yMin[gx] = ny
      if (ny > yMax[gx]) yMax[gx] = ny
    }
  }
  for (let i = 0; i < gw; i++) dens[i] /= gh
  return { dens, yMin, yMax }
}

function smooth(prof, radius = 1) {
  const out = new Float32Array(prof.length)
  for (let i = 0; i < prof.length; i++) {
    let s = 0, n = 0
    for (let d = -radius; d <= radius; d++) {
      const j = i + d
      if (j < 0 || j >= prof.length) continue
      s += prof[j]; n++
    }
    out[i] = s / n
  }
  return out
}

function findBands(prof, thresh, maxGap) {
  const bands = []
  let start = -1
  for (let i = 0; i < prof.length; i++) {
    const hit = prof[i] >= thresh
    if (hit && start < 0) start = i
    if (!hit && start >= 0) { bands.push({ i0: start, i1: i - 1 }); start = -1 }
  }
  if (start >= 0) bands.push({ i0: start, i1: prof.length - 1 })
  const merged = []
  for (const b of bands) {
    const last = merged[merged.length - 1]
    if (last && b.i0 - last.i1 <= maxGap) last.i1 = b.i1
    else merged.push({ i0: b.i0, i1: b.i1 })
  }
  return merged
}

/**
 * 单独取玩家位置（归一化 x）。跟 detectEnemies 用同一套判据，单独导出来是为了
 * 离线核对、跑标定，以及将来 autoplay 想拿它做「我站在画面哪」的旁证。
 * @returns {{x:number, y:number, n:number}|null}
 */
export function locatePlayerX({ rgba, width, height } = {}) {
  if (!rgba || !(width > 0) || !(height > 0) || rgba.length < width * height * 4) return null
  const g = gridStats(rgba, width, height)
  const p = locatePlayer(g.gw, g.gh, g.cyan)
  return p ? { x: p.x, y: p.y, n: p.n } : null
}

/**
 * 检测画面里的敌人。
 *
 * @param {{rgba: Uint8Array|Buffer, width: number, height: number,
 *          minDensity?: number, minWidthFrac?: number, guardFrac?: number}} frame
 *   rgba / width / height  一帧 RGBA8（长度 width*height*4）
 *   minDensity     暖色带最小平均密度（默认 0.030）
 *   minWidthFrac   暖色带最小宽度占画面宽（默认 0.030）
 *   guardFrac      玩家两侧保护区半宽（默认 0.045），排掉自己的剑光与身体
 * @returns {{side: 'left'|'right'|null, x: number|null, count: number, conf: number}}
 *   side  敌人在玩家左边还是右边（判不出来 = null）
 *   x     敌人带中心的归一化 x
 *   count 候选带数量
 *   conf  0~1 置信度
 */
export function detectEnemies({
  rgba, width, height,
  minDensity = 0.030, minWidthFrac = 0.030, guardFrac = 0.045,
} = {}) {
  const empty = { side: null, x: null, count: 0, conf: 0 }
  if (!rgba || !(width > 0) || !(height > 0) || rgba.length < width * height * 4) return empty

  const g = gridStats(rgba, width, height)
  // 全屏青色占比过高 ⇒ 画面被自己的大招青特效糊满，玩家的位置不可信 → 不给方向
  if (g.cyanFrac > 0.09) return empty
  const player = locatePlayer(g.gw, g.gh, g.cyan)
  if (!player) return empty // 找不到自己在哪，就不给方向（宁缺勿错）

  const { dens, yMin, yMax } = warmColumns(g.gw, g.gh, g.warm)
  const prof = smooth(dens, 1)
  const bands = findBands(prof, minDensity, Math.max(1, Math.round(GRID_COLS * 0.02)))
  const px = player.x

  const cands = []
  for (const b of bands) {
    const wFrac = (b.i1 - b.i0 + 1) / GRID_COLS
    if (wFrac < minWidthFrac) continue
    let sum = 0, peak = 0
    for (let i = b.i0; i <= b.i1; i++) { sum += prof[i]; if (prof[i] > peak) peak = prof[i] }
    const mean = sum / (b.i1 - b.i0 + 1)
    const x = (b.i0 + b.i1 + 1) / 2 / GRID_COLS
    let lo = 1, hi = 0
    for (let i = b.i0; i <= b.i1; i++) {
      if (yMin[i] < lo) lo = yMin[i]
      if (yMax[i] > hi) hi = yMax[i]
    }
    const hFrac = hi - lo
    if (hFrac < 0.06) continue // 只有一个像素高的暖色线 → 噪点
    if (Math.abs(x - px) < guardFrac) continue
    cands.push({ x, wFrac, hFrac, mean, peak })
  }
  if (!cands.length) return empty

  const scoreOf = (c) => c.mean * Math.min(1, c.wFrac / 0.10) * Math.min(1, c.hFrac / 0.28)
  cands.sort((a, b) => scoreOf(b) - scoreOf(a) || Math.abs(a.x - px) - Math.abs(b.x - px))
  const top = cands[0]
  const side = top.x < px ? 'left' : 'right'
  const conf = Math.max(0, Math.min(1,
    Math.min(1, top.mean / 0.08) * 0.45 +
    Math.min(1, top.wFrac / 0.12) * 0.25 +
    Math.min(1, top.hFrac / 0.35) * 0.30))
  return { side, x: top.x, count: cands.length, conf }
}

/**
 * lib/ui/scan.mjs —— 通用画面扫描原语（**不含任何具体游戏的坐标和阈值**）
 * ============================================================================
 * 这是「界面层」：只提供几个跟游戏无关的像素统计工具。
 * 具体游戏的 HUD 在哪、提示框在哪、什么亮度算亮 —— 都由调用方（比如
 * lib/games/icey/layout.mjs）传进来。
 *
 * 为什么要这一层（2026-10-24）：
 *   原来 analyzeFrame 把「怎么统计」和「ICEY 的坐标/阈值」揉在一个函数里。
 *   结果是换个游戏就得改核心函数、也没法单独测试统计逻辑。
 *   参考 GameScaling 论文的一个观察（interface phase / world phase）：
 *   界面交互那一层是跨游戏通用的，具体世界的知识才是每个游戏各写各的。
 *
 * 采样步长（yStep/xStep/byteStep）是**刻意暴露的参数**：
 *   同一个画面用不同步长算出来的值不一样，所以重构时靠显式传参来保证
 *   「行为完全不变」，而不是靠猜。probe/ab-analyze.mjs 有 A/B 基线守着这件事。
 * ============================================================================
 */

/** 亮度权重（BT.601，跟全项目一致） */
export const LUM_R = 0.299
export const LUM_G = 0.587
export const LUM_B = 0.114

/** 相对坐标的框 {x0,y0,x1,y1}（0~1 比例） */
export function boxToPixels(box, width, height) {
  return {
    x0: Math.floor(width * box.x0),
    x1: Math.floor(width * box.x1),
    y0: Math.floor(height * box.y0),
    y1: Math.floor(height * box.y1),
  }
}

/**
 * 一个区域里的亮度统计。
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {{x0:number,y0:number,x1:number,y1:number}} box 相对坐标
 * @param {{lumMin?:number, yStep?:number, xStep?:number}} opts
 *        lumMin 给定时额外算 brightRatio（亮度 > lumMin 的采样点占比）
 * @returns {{mean:number, brightRatio:number, count:number}}
 */
export function regionStats(rgba, width, height, box, opts = {}) {
  const { lumMin = null, yStep = 2, xStep = 2 } = opts
  const px = boxToPixels(box, width, height)
  let sum = 0
  let bright = 0
  let count = 0
  for (let y = px.y0; y < px.y1; y += yStep) {
    const rowBase = y * width * 4
    for (let x = px.x0; x < px.x1; x += xStep) {
      const i = rowBase + x * 4
      const lum = rgba[i] * LUM_R + rgba[i + 1] * LUM_G + rgba[i + 2] * LUM_B
      sum += lum
      if (lumMin !== null && lum > lumMin) bright++
      count++
    }
  }
  return {
    mean: count ? sum / count : 0,
    brightRatio: count ? bright / count : 0,
    count,
  }
}

/**
 * 某个区域里满足颜色谓词的采样点占比。
 *
 * 和 regionStats 的区别：那个只认「亮不亮」，这个认「什么颜色」。
 * 用来找带色的具体 UI —— 比如 ICEY 左上角那串**黄色的连击数字**。
 *
 * @param {(r:number,g:number,b:number)=>boolean} test 命中返回 true
 * @param {{yStep?:number, xStep?:number}} opts
 */
export function colorRatio(rgba, width, height, box, test, opts = {}) {
  const { yStep = 2, xStep = 2 } = opts
  const px = boxToPixels(box, width, height)
  let hit = 0
  let count = 0
  for (let y = px.y0; y < px.y1; y += yStep) {
    const rowBase = y * width * 4
    for (let x = px.x0; x < px.x1; x += xStep) {
      const i = rowBase + x * 4
      count++
      if (test(rgba[i], rgba[i + 1], rgba[i + 2])) hit++
    }
  }
  return count ? hit / count : 0
}

/**
 * 蓝色血条占比 —— 血条区域里「蓝色」像素占该区域的比例。
 * 蓝色判据按实测样本 RGB≈(96,140,168)：蓝明显高于红，绿居中。
 */
export function blueRatioInBox(rgba, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0 * width))
  const x1 = Math.min(width, Math.ceil(box.x1 * width))
  const y0 = Math.max(0, Math.floor(box.y0 * height))
  const y1 = Math.min(height, Math.ceil(box.y1 * height))
  let blue = 0, total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      total++
      if (b > r + 25 && b > 60 && g > r && g < b + 40) blue++
    }
  }
  return total ? blue / total : 0
}

/**
 * 黄色护盾占比 —— 护盾区域里「黄」像素占该区域的比例。
 * 护盾是一排黄色箭头，每格一个；破了格数就少，黄像素比例随之下降。
 */
export function yellowRatioInBox(rgba, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0 * width))
  const x1 = Math.min(width, Math.ceil(box.x1 * width))
  const y0 = Math.max(0, Math.floor(box.y0 * height))
  const y1 = Math.min(height, Math.ceil(box.y1 * height))
  let yellow = 0, total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      total++
      if (r > 140 && g > 110 && b < 110 && r - b > 60 && g - b > 40) yellow++
    }
  }
  return total ? yellow / total : 0
}

/**
 * 全图找「黄色实心箭头」—— 它表示**那个方向有敌人**（2026-10-25 用户说明）。
 *
 * 跟「白色空心箭头」不是一回事，别混：
 *   白色空心（guide-arrow.mjs）：暗白细描边、空心、亮度只有 64~114 ⇒ 路标，往这走
 *   黄色实心（这个函数）    ：纯黄、实心、高饱和            ⇒ 敌情，那边有敌人
 *
 * 实测样本（用户提供的裁剪图，72x73）：
 *   红 151~251（中位 251）、绿 155~255（中位 255）、蓝 0~93（中位 0）
 *   像素样本 (251, 255, 0)、(239, 243, 14)
 *   ⇒ 比连击那个黄亮得多，不能用 isComboYellow 那套松判据。
 *
 * 位置不固定（不像连击数在左上角固定框里），所以扫全图，按列统计找密集带。
 */
export function findYellowArrow(rgba, width, height, opts = {}) {
  const {
    minRatio = 0.015,   // 单列黄色像素占全高的比例下限
    maxRatio = 0.55,    // 上限（整列全黄不像箭头，像整片特效）
    minSpan = 0.013,    // 密集带宽度占画面宽的下限（太窄是噪点）
    maxSpan = 0.30,     // 上限（太宽不是箭头；裁剪样本能占近半屏，留够余量）
  } = opts

  // 逐列数「纯黄」像素
  const cols = new Float32Array(width)
  for (let y = 0; y < height; y++) {
    const base = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = base + x * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (r > 180 && g > 160 && b < 100 && r - b > 100 && g - b > 100) cols[x]++
    }
  }

  // 找出超过阈值的连续列段
  const bands = []
  let start = -1
  for (let x = 0; x < width; x++) {
    const ratio = cols[x] / height
    const hit = ratio >= minRatio && ratio <= maxRatio
    if (hit && start < 0) start = x
    if (!hit && start >= 0) {
      bands.push({ x0: start, x1: x - 1 })
      start = -1
    }
  }
  if (start >= 0) bands.push({ x0: start, x1: width - 1 })

  // 按尺寸筛，取最宽的一块（箭头本体）
  let best = null
  let bestSpan = 0
  for (const b of bands) {
    const span = (b.x1 - b.x0 + 1) / width
    if (span < minSpan || span > maxSpan) continue
    if (span > bestSpan) {
      bestSpan = span
      best = b
    }
  }
  // 2026-10-29：diag 模式把**被拒掉的候选**也带出来。
  //   怀疑敌人箭头宽度卡在 minSpan（0.025）下面，但此前没有任何输出能证明这件事 —— 只能猜。
  //   这里只加诊断，判定行为一个字没改。
  if (opts.diag) {
    const list = bands
      .map((b) => ({
        x: +(((b.x0 + b.x1) / 2) / width).toFixed(3),
        span: +(((b.x1 - b.x0 + 1) / width)).toFixed(4),
      }))
      .sort((a, b) => b.span - a.span)
      .slice(0, 5)
    // 2026-10-29 再加一层：**画面里明明有亮黄箭头，这里却说没有黄块**。
    // 与其继续猜「是色域还是通道顺序」，直接把「它眼里的黄」摊开：
    //   yellowish = 放宽一档（r>140,g>120,b<120）数到的像素数 —— 如果这个数是 0，
    //   说明整张图根本没有「红高蓝低」的像素，那问题就不是阈值而是通道顺序；
    //   sample = 其中最亮的那个像素的原始 RGB（照现在这套判据，它本该是黄的）。
    let yellowish = 0
    let sample = null
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (r > 140 && g > 120 && b < 120 && r - b > 60 && g - b > 50) {
        yellowish++
        if (!sample || r + g > sample[0] + sample[1]) sample = [r, g, b]
      }
    }
    const diag = { minSpan, maxSpan, bands: list, yellowish, sample, size: `${width}x${height}` }
    if (!best) return { arrow: null, diag }
    return { arrow: { x: ((best.x0 + best.x1) / 2) / width, span: bestSpan }, diag }
  }
  if (!best) return null
  return {
    x: ((best.x0 + best.x1) / 2) / width,   // 归一化中心
    span: bestSpan,
  }
}

/**
 * 全图找「红色文字行」—— 用来判「在不在菜单」。
 *
 * 为什么用这个：ICEY 的暂停菜单压暗 92%、hudBright=0，和黑屏过场一模一样，
 * 靠亮度和条带都分不开。但菜单里有一行**固定的红色警告**：
 *   「警告：退出游戏将会令您失去上一个存档点之后的全部数据」
 * 它是细长、稀疏的（笔画），而战斗里的红色特效是块状、密集的，形状不同。
 *
 * 全图扫描而不是固定窗口 —— 菜单有滑动动画，文字位置每帧都在变。
 *
 * 🔴 2026-10-26 修：这条判据原来只在 **1280×745** 上标定过，而插件实际的分析宽度是
 *    `analysisWidth`（默认 480、可配 320~800）。分辨率一换，两件事同时出错（都实测过）：
 *
 *    真菜单（shots/menu-check/f_000）：
 *      1280 宽 → 警告行高 11 行、红像素 899  → 判出 1 条 ✓
 *       960 宽 → 判出 1 条 ✓
 *       640 宽 → 0 条 ✗   480 宽 → 0 条 ✗   400 宽 → 0 条 ✗
 *      原因：缩到 480 后那行只剩 **3 行高**，被 `minBandHeight = 5` 整个滤掉。
 *      ⇒ 默认配置下暂停菜单根本认不出来，插件不会按 Esc 退出它。
 *
 *    战斗红特效（shots/combat 593 张）：
 *      480 宽下有 28 帧被判成「有红色文字行」，决策层因此按了 22 次 Esc。
 *      画面里其实是**红色霓虹窗和红色伤害火花**（c0039 / c0369 已人工确认是真战斗帧）。
 *
 *    两者靠「笔画粗细」分得开（游程 = 一行里连续红色像素的长度）：
 *      真菜单警告行  平均游程 1.51px（480）／2.35px（1280），最宽 3／10px
 *      战斗红特效    平均游程 3.05 ~ 32.76px，最宽 6 ~ 124px
 *    ⇒ 加 `maxAvgRunW`：按 480 归一后平均游程超过它就当「块状特效」丢掉。
 *
 * 2026-10-25 实测（1280x745）：
 *   暂停菜单      1 条（y271-281，红像素 916）
 *   普通游戏画面  0 条
 *   战斗红特效    0 条（6 帧全 0）—— ⚠️ 这句只在 1280 下成立，480 下不成立，见上。
 */
export function findRedTextRows(rgba, width, height, opts = {}) {
  const {
    minRedPerRow = 18, minDensity = 0.008, maxDensity = 0.32,
    minBandHeight = 5,     // 以 1280 宽为基准，下面按分辨率折算
    maxAvgRunW = 2.4,      // 归一到 480 宽后的平均横向游程上限（见上面注释的实测值）
  } = opts
  // 折算：1280 下要 5 行高，480 下 3 行高的文字行也该算
  const minBandPx = Math.max(2, Math.round((minBandHeight * width) / 1280))
  const runScale = 480 / width
  const rows = []
  for (let y = 0; y < height; y++) {
    let red = 0
    const base = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = base + x * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (r > 150 && g < 110 && b < 110 && r - g > 60) red++
    }
    const density = red / width
    if (red >= minRedPerRow && density >= minDensity && density <= maxDensity) rows.push({ y, red })
  }
  const bands = []
  for (const r of rows) {
    const last = bands[bands.length - 1]
    if (last && r.y - last.y1 <= 2) {
      last.y1 = r.y
      last.red += r.red
    } else {
      bands.push({ y0: r.y, y1: r.y, red: r.red })
    }
  }
  const isRed = (r, g, b) => r > 150 && g < 110 && b < 110 && r - g > 60
  return bands.filter((b) => {
    const h = b.y1 - b.y0 + 1
    if (h < minBandPx) return false
    // 数一下横向游程：文字是很多根细笔画，特效是少数几块大色斑
    let runs = 0
    for (let y = b.y0; y <= b.y1; y++) {
      let run = 0
      const base = y * width * 4
      for (let x = 0; x < width; x++) {
        const i = base + x * 4
        if (isRed(rgba[i], rgba[i + 1], rgba[i + 2])) {
          run++
        } else if (run > 0) {
          runs++
          run = 0
        }
      }
      if (run > 0) runs++
    }
    const avgRunW = b.red / Math.max(1, runs)
    return avgRunW * runScale <= maxAvgRunW
  })
}

/**
 * 字幕/白字行检测：在给定框里数「像文字的白字行」。
 *
 * 2026-10-26 加。此前的字幕判据只有「框内亮像素占比 > SUBTITLE_MIN」，
 * 实测会把**地面亮草、白花、角色的青色特效**全算成「有人在说话」——
 * 两轮实机里字根本没出现，却各裁了一张空字幕图（框里只有脚和草）。
 *
 * 判据跟菜单那条红字同源：文字是**一行行的细笔画**，环境亮点是**成片的色块**。
 * 所以复用同一套「行 → 带 → 横向游程」的结构，只把颜色谓词换成「亮且近白」。
 */
export function findBrightTextRows(rgba, width, height, box, opts = {}) {
  const {
    lumMin = 225,
    minWhitePerRow = 10,
    minDensity = 0.004,
    maxDensity = 0.35,
    minBandHeight = 3,
    maxAvgRunW = 2.6,
  } = opts
  const px = boxToPixels(box, width, height)
  const boxW = Math.max(1, px.x1 - px.x0)
  const minBandPx = Math.max(2, Math.round((minBandHeight * width) / 1280))
  const runScale = 480 / width
  const isWhite = (i) => {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
    const lum = r * LUM_R + g * LUM_G + b * LUM_B
    return lum >= lumMin && Math.abs(r - g) < 40 && Math.abs(g - b) < 40
  }
  const rows = []
  for (let y = px.y0; y < px.y1; y++) {
    let white = 0
    const base = y * width * 4
    for (let x = px.x0; x < px.x1; x++) {
      if (isWhite(base + x * 4)) white++
    }
    const density = white / boxW
    if (white >= minWhitePerRow && density >= minDensity && density <= maxDensity) {
      rows.push({ y, white })
    }
  }
  const bands = []
  for (const r of rows) {
    const last = bands[bands.length - 1]
    if (last && r.y - last.y1 <= 2) {
      last.y1 = r.y
      last.white += r.white
    } else {
      bands.push({ y0: r.y, y1: r.y, white: r.white })
    }
  }
  return bands.filter((b) => {
    if (b.y1 - b.y0 + 1 < minBandPx) return false
    let runs = 0
    for (let y = b.y0; y <= b.y1; y++) {
      let run = 0
      const base = y * width * 4
      for (let x = px.x0; x < px.x1; x++) {
        if (isWhite(base + x * 4)) run++
        else if (run > 0) { runs++; run = 0 }
      }
      if (run > 0) runs++
    }
    const avgRunW = b.white / Math.max(1, runs)
    return avgRunW * runScale <= maxAvgRunW
  })
}

/**
 * 全画面「很亮」像素占比（特效强度）。
 * 按字节步长采样：每 byteStep 个字节取一个点（byteStep 必须是 4 的倍数）。
 */
export function globalBrightRatio(rgba, width, height, lumMin, byteStep = 16) {
  const n = width * height * 4
  let bright = 0
  let total = 0
  for (let i = 0; i < n; i += byteStep) {
    const lum = rgba[i] * LUM_R + rgba[i + 1] * LUM_G + rgba[i + 2] * LUM_B
    if (lum > lumMin) bright++
    total++
  }
  return total ? bright / total : 0
}

/**
 * 两帧之间「明显变化」的采样点占比（动作量）。
 * 判定：任一通道差 > threshold 就算变。
 * 步长沿用原来的算法：n/24000 再对齐到 4 的倍数，最少 4。
 */
export function frameDiffRatio(a, b, threshold = 12) {
  const n = Math.min(a.length, b.length)
  const stride = Math.max(4, Math.floor(n / 24000 / 4) * 4)
  let changed = 0
  let total = 0
  for (let i = 0; i < n; i += stride) {
    total++
    if (Math.abs(a[i] - b[i]) > threshold ||
        Math.abs(a[i + 1] - b[i + 1]) > threshold ||
        Math.abs(a[i + 2] - b[i + 2]) > threshold) changed++
  }
  return total ? changed / total : 0
}

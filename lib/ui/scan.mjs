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
 * 2026-10-25 实测（1280x745）：
 *   暂停菜单      1 条（y271-281，红像素 916）
 *   普通游戏画面  0 条
 *   战斗红特效    0 条（6 帧全 0）
 */
export function findRedTextRows(rgba, width, height, opts = {}) {
  const { minRedPerRow = 18, minDensity = 0.008, maxDensity = 0.32, minBandHeight = 5 } = opts;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let red = 0;
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (r > 150 && g < 110 && b < 110 && r - g > 60) red++;
    }
    const density = red / width;
    if (red >= minRedPerRow && density >= minDensity && density <= maxDensity) rows.push({ y, red });
  }
  const bands = [];
  for (const r of rows) {
    const last = bands[bands.length - 1];
    if (last && r.y - last.y1 <= 2) {
      last.y1 = r.y;
      last.red += r.red;
    } else {
      bands.push({ y0: r.y, y1: r.y, red: r.red });
    }
  }
  return bands.filter((b) => b.y1 - b.y0 + 1 >= minBandHeight);
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

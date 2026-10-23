/**
 * lib/config.mjs —— 配置的默认值与归一化（纯函数，不 import 任何 DSH 服务）
 * ============================================================================
 * Config 的 schemastery 定义在 index.js 里（要 .extra('volatile', true) 才能热改）；
 * 这里只放「拿到的值怎么变可信」：夹范围、合并 keyMap、未知枚举回落。
 * 纯函数 ⇒ selfcheck 能直接测，不需要起 DSH。
 * ============================================================================
 */

/** ICEY 默认键位（来自 PlayerPrefs 的 KeyMap，vk 转字符） */
export const DEFAULT_KEYMAP = {
  moveUp: 'w',
  moveDown: 's',
  moveLeft: 'a',
  moveRight: 'd',
  attack: 'j',
  jump: ' ',
  heavy: 'i',
  execute: 'l',
  dash: 'o',
  chase: 'u',
  storm: '8',   // 强化技：湍流（刀风暴）
  shade: '9',   // 强化技：流场（分身斩）
}

export const DEFAULTS = {
  gameDir: 'D:\\SteamLibrary\\steamapps\\common\\ICEY',
  exePath: '',
  steamAppId: '553640',
  launchMode: 'attach',
  keyMap: { ...DEFAULT_KEYMAP },
  // 10fps 够看，又不是 CPU 大户。上限 12 —— 再高对「看画面」没有意义，只是烧 CPU
  fps: 10,
  // 面板画面的宽度：960 是「看得清角色/血条/文字」和「2MB/帧」的平衡点。
  // 原始 1606 宽是 6MB/帧，10fps 就是 60MB/s —— 那是把 DSH 拖死的元凶。
  streamWidth: 960,
  inputBackend: 'sendinput',
  captureMode: 'printwindow',
  koffiPath: '',
  allowFocus: true,
  // 动作结束后把焦点还给用户原来的窗口。关掉的话，玩一会儿 DSH 就一直被游戏压着
  restoreFocus: true,
  windowedFix: false,
  maxFrameWidth: 1280,
}

const LAUNCH_MODES = ['attach', 'steam', 'direct']
const INPUT_BACKENDS = ['sendinput', 'postmessage']
const CAPTURE_MODES = ['printwindow', 'bitblt']

function num(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function pick(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback
}

function str(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

/**
 * 把用户配置变成可信配置。永远返回完整对象（不会缺字段）。
 * @param {Record<string, any>} [raw]
 */
export function normalizeConfig(raw = {}) {
  const keyMap = { ...DEFAULT_KEYMAP }
  if (raw.keyMap && typeof raw.keyMap === 'object') {
    for (const k of Object.keys(DEFAULT_KEYMAP)) {
      const v = raw.keyMap[k]
      if (typeof v === 'string' && v.length >= 1) keyMap[k] = v
    }
  }
  return {
    gameDir: str(raw.gameDir, DEFAULTS.gameDir),
    exePath: str(raw.exePath, DEFAULTS.exePath),
    steamAppId: str(raw.steamAppId, DEFAULTS.steamAppId),
    launchMode: pick(raw.launchMode, LAUNCH_MODES, DEFAULTS.launchMode),
    keyMap,
    // 12 fps 是上限：再高 SSE + GDI 抓帧会把宿主主线程拖住，人眼也看不出差别
    fps: num(raw.fps, DEFAULTS.fps, 1, 12),
    // 面板画面宽度：320–1600。超过 1280 就没必要了（面板也显示不了那么大）
    streamWidth: num(raw.streamWidth, DEFAULTS.streamWidth, 320, 1280),
    inputBackend: pick(raw.inputBackend, INPUT_BACKENDS, DEFAULTS.inputBackend),
    captureMode: pick(raw.captureMode, CAPTURE_MODES, DEFAULTS.captureMode),
    koffiPath: str(raw.koffiPath, DEFAULTS.koffiPath),
    allowFocus: typeof raw.allowFocus === 'boolean' ? raw.allowFocus : DEFAULTS.allowFocus,
    restoreFocus: typeof raw.restoreFocus === 'boolean' ? raw.restoreFocus : DEFAULTS.restoreFocus,
    windowedFix: typeof raw.windowedFix === 'boolean' ? raw.windowedFix : DEFAULTS.windowedFix,
    // 1568 是模型侧图片的常见边长上限，宽留到 1280 更省 token
    maxFrameWidth: num(raw.maxFrameWidth, DEFAULTS.maxFrameWidth, 320, 1568),
  }
}

/** 取可执行文件路径（exePath 优先，其次 gameDir\ICEY.exe） */
export function exePathOf(cfg) {
  if (cfg.exePath) return cfg.exePath
  const dir = cfg.gameDir.replace(/[\\/]+$/, '')
  return `${dir}\\ICEY.exe`
}

/** 窗口化启动参数（稳妥；独占全屏也能跑，但窗口化抓帧/切窗口更省事） */
export const WINDOWED_ARGS = ['-screen-width', '1600', '-screen-height', '900', '-screen-fullscreen', '0']

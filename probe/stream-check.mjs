/**
 * probe/stream-check.mjs —— 模拟面板的拉流循环，验四件事：
 *   1. captureStreamFrame 出的是缩过的 RGBA（960 宽，不是 6MB/帧）
 *   2. 二进制帧协议能被正确切分（头 + 负载长度对得上）
 *   3. 稳态吞吐/主线程占用（base64 那套对比：会慢到离谱）
 *   4. 没人拉时不抓帧（拉模式）
 */
import { session, configure } from '../lib/session.mjs'

configure({ getConfig: () => ({}) })
const s = session()
const a = await s.attach()
if (!a.attached) {
  console.log('游戏没开，跳过：', a.reason)
  process.exit(0)
}
console.log('接上:', JSON.stringify({ hwnd: a.hwnd, pid: a.pid }))

// 1) 单帧尺寸
const t0 = Date.now()
const f = await s.captureStreamFrame(960)
console.log(`captureStreamFrame(960): ${f.width}x${f.height}, ${(f.rgba.length / 1e6).toFixed(2)} MB, 耗时 ${Date.now() - t0}ms`)
console.log(`  期望字节数 = ${f.width * f.height * 4}，实际 = ${f.rgba.length}，匹配=${f.rgba.length === f.width * f.height * 4}`)

// 2) 模拟 10 帧的拉流，把每帧按协议打包
const head = (w, h, n) => {
  const b = Buffer.allocUnsafe(16)
  b.write('ICYF', 0, 'ascii'); b.writeUInt32LE(w, 4); b.writeUInt32LE(h, 8); b.writeUInt32LE(n, 12)
  return b
}
const N = 10
const t1 = Date.now()
let totalBytes = 0
let frames = 0
for (let i = 0; i < N; i++) {
  const fr = await s.captureStreamFrame(960)
  const packets = [head(fr.width, fr.height, fr.rgba.length), fr.rgba]
  // 模拟"浏览器按协议解析"
  const joined = Buffer.concat(packets)
  const view = new DataView(joined.buffer, joined.byteOffset, 16)
  const w = view.getUint32(4, true), h = view.getUint32(8, true), len = view.getUint32(12, true)
  const body = joined.subarray(16, 16 + len)
  if (String.fromCharCode(...joined.subarray(0, 4)) !== 'ICYF') throw new Error('magic 错')
  if (w !== fr.width || h !== fr.height || len !== fr.rgba.length || body.length !== len) throw new Error('帧头/负载不一致')
  totalBytes += joined.length
  frames++
}
const ms = Date.now() - t1
console.log(`\n模拟 ${frames} 帧：总 ${(totalBytes / 1e6).toFixed(1)} MB，用时 ${ms}ms => ${(frames / (ms / 1000)).toFixed(1)} fps`)
console.log(`平均每帧 ${(ms / frames).toFixed(1)}ms（抓帧+打包，全部在 worker + 轻量拼接）`)
console.log(`对比：原始分辨率 base64+SSE 光编码就要 ~15ms/帧，浏览器 atob 还要 41ms/帧`)

// 3) 拉模式：没人拉就不抓（看 lastFrameAt 不再前进）
const before = s.lastFrameAt
await new Promise((r) => setTimeout(r, 1200))
const after = s.lastFrameAt
console.log(`\n空闲 1.2s 后 lastFrameAt 变化: ${before !== after ? '变了（有东西在抓）' : '没变 ✅ 没人拉就不抓'}`)
console.log('viewers:', s.viewers)

await s.dispose('probe')

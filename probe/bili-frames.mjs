/**
 * probe/bili-frames.mjs —— 拉一个 B站视频并按间隔抽帧（用本地 ffmpeg）
 *
 * 为什么需要它：bili_humanism 的读视频额度会耗尽，而 B站 视频本身没有字幕时，
 * 唯一能"看懂"内容的方式就是抽帧看图。本机已装 ffmpeg（winget Gyan.FFmpeg）。
 *
 * 用法：
 *   node probe/bili-frames.mjs BV1314y1k7Zy            # 每 2 秒一帧
 *   node probe/bili-frames.mjs BV1314y1k7Zy 1          # 每 1 秒一帧
 *   node probe/bili-frames.mjs BV1314y1k7Zy 2 60 180   # 每 2 秒一帧，只取 60~180 秒
 *
 * 输出：shots/bili/<bvid>/f0001.png … 并打印清单（含时间戳）
 */
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const bvid = process.argv[2]
if (!bvid || !/^BV[0-9A-Za-z]+$/.test(bvid)) {
  console.error('用法: node probe/bili-frames.mjs BV号 [间隔秒=2] [起始秒] [结束秒]')
  process.exit(2)
}
const every = Number(process.argv[3]) || 2
const from = process.argv[4] ? Number(process.argv[4]) : 0
const to = process.argv[5] ? Number(process.argv[5]) : 0

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}` }

const jget = async (url) => {
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

/* ① 视频信息 */
const info = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (info.code !== 0) {
  console.error('取视频信息失败:', info.code, info.message)
  process.exit(1)
}
const d = info.data
const page = d.pages[0]
console.log(`《${d.title}》 ${d.duration}s  分P ${d.videos}  当前 P1 cid=${page.cid}`)

/* ② 取播放地址（不登录一般只能拿到 360P 的合并流，够抽帧用） */
async function playurl(qn) {
  const urls = [
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${page.cid}&qn=${qn}&fnval=0&fourk=0`,
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${page.cid}&qn=${qn}&fnval=0&platform=html5&high_quality=1`,
  ]
  for (const u of urls) {
    try {
      const j = await jget(u)
      if (j.code === 0 && j.data?.durl?.length) return j.data
    } catch { /* 换下一个 */ }
  }
  return null
}

let play = null
for (const qn of [64, 32, 16]) {
  play = await playurl(qn)
  if (play) { console.log(`拿到流: qn=${qn} 清晰度=${play.quality}  分段=${play.durl.length}`); break }
}
if (!play) {
  console.error('拿不到播放地址（可能需要登录或该视频受限）')
  process.exit(1)
}

/* ③ 下载 */
const dir = join('shots', 'bili', bvid)
mkdirSync(dir, { recursive: true })
const mp4 = join(dir, 'video.mp4')
{
  const r = await fetch(play.durl[0].url, { headers: H, signal: AbortSignal.timeout(300000) })
  if (!r.ok) { console.error('下载失败 HTTP', r.status); process.exit(1) }
  const buf = Buffer.from(await r.arrayBuffer())
  writeFileSync(mp4, buf)
  console.log(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${mp4}`)
}

/* ④ 抽帧 */
const outDir = join(dir, from || to ? `frames_${from}_${to || 'end'}` : 'frames')
mkdirSync(outDir, { recursive: true })
const args = ['-hide_banner', '-loglevel', 'error', '-y']
if (from) args.push('-ss', String(from))
args.push('-i', mp4)
if (to) args.push('-t', String(Math.max(1, to - from)))
args.push('-vf', `fps=1/${every},scale=640:-1`)
args.push(join(outDir, 'f%04d.png'))
execFileSync('ffmpeg', args, { stdio: 'inherit' })

const files = readdirSync(outDir).filter((f) => f.endsWith('.png')).sort()
console.log(`\n抽了 ${files.length} 帧，每 ${every}s 一张（宽 640）：`)
for (const f of files) {
  const idx = Number(f.match(/f(\d+)/)[1])
  const t = from + (idx - 1) * every
  const kb = Math.round(statSync(join(outDir, f)).size / 1024)
  console.log(`  ${join(outDir, f)}  ≈ ${String(Math.floor(t / 60))}:${String(t % 60).padStart(2, '0')}  (${kb}KB)`)
}

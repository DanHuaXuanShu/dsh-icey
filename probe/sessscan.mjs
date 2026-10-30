// 一次性的：把 DSH 的 v4 会话日志（多帧 zstd）解开，在里面找插件动作记录的原文。
//
//   node probe/_sessscan.mjs <session.v4.jsonl.zstd> <要找的词> [最多打几条]
//
// 为什么要自己拆帧：Node 的 zstdDecompressSync 只解**第一帧**，而 DSH 是每追加一批就
// 压一帧、再把帧拼起来 —— 直接解只拿到开头几十字节（实测 2 行）。所以按魔数切帧再逐帧解。
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const needle = process.argv[3] || ''
const limit = Number(process.argv[4] || 5)
if (!file) { console.log('用法：node probe/_sessscan.mjs <文件.zstd> [词] [条数]'); process.exit(1) }

const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
let text = ''
let ok = 0, bad = 0
for (let k = 0; k < starts.length; k++) {
  const a = starts[k]
  const b = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    text += zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8')
    ok++
  } catch { bad++ }
}
console.log(`帧 ${starts.length}（解开 ${ok}，失败 ${bad}），正文 ${(text.length / 1024 / 1024).toFixed(1)} MB`)

const lines = text.split('\n')
if (!needle) {
  console.log('不给词就只看总行数：', lines.length)
  process.exit(0)
}
const hits = lines.filter((l) => l.includes(needle))
console.log(`含「${needle}」的行 ${hits.length} 条`)
for (const h of hits.slice(0, limit)) {
  const idx = h.indexOf(needle)
  console.log('---\n' + h.slice(Math.max(0, idx - 220), idx + 260).replace(/\\n/g, '\n'))
}
void MAGIC

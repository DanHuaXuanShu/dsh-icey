// 只读：解压会话日志的一小段，看清 JSONL 结构。不写任何东西到会话目录。
import fs from 'node:fs'
import zlib from 'node:zlib'

const p = process.argv[2]
const want = Number(process.argv[3] || 3)
if (!p) { console.error('用法: node scripts/session-peek.mjs <文件> [行数]'); process.exit(1) }

const raw = fs.readFileSync(p)
// 一次全解压（会话文件最大 30MB，解压后百 MB 级；peek 只在必要时用）
const buf = zlib.zstdDecompressSync ? zlib.zstdDecompressSync(raw) : (() => { throw new Error('本机 node 没有 zstdDecompressSync') })()
const text = buf.toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log(`解压后 ${(buf.length / 1048576).toFixed(1)}MB，${lines.length} 行`)

for (let i = 0; i < Math.min(want, lines.length); i++) {
  let o
  try { o = JSON.parse(lines[i]) } catch { console.log(`line ${i} 不是 JSON`); continue }
  console.log(`--- line ${i} keys: ${Object.keys(o).join(',')}`)
  console.log(JSON.stringify(o).slice(0, 900))
}
console.log('--- 最后一行 keys ---')
const lastO = JSON.parse(lines[lines.length - 1])
console.log(JSON.stringify(lastO).slice(0, 600))

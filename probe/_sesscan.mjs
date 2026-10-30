import fs from 'node:fs'
import zlib from 'node:zlib'
const f = 'C:/Users/m1878/.dsh/sessions/--D-dsh-ICEY~63D2~4EF6--/session-3895e57c-4c1f-4473-bb15-024beecfabcc/session.v4.jsonl.zstd'
const buf = zlib.zstdDecompressSync(fs.readFileSync(f))
const text = buf.toString('utf8')
const lines = text.split('\n')
console.log('解压后', (buf.length/1024/1024).toFixed(1), 'MB,', lines.length, '行')
const hits = { sweep: 0, chase: 0, play: 0 }
const samples = []
for (const ln of lines) {
  if (ln.includes('沿地面往')) { hits.sweep++; if (samples.length < 6) samples.push(ln.slice(0, 500)) }
  if (ln.includes('在打架') && ln.includes('挪一下')) hits.chase++
  if (ln.includes('icey_play')) hits.play++
}
console.log('命中', JSON.stringify(hits))
for (const s of samples) console.log('---\n' + s)

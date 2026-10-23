// 量化「每帧 6MB RGBA → base64 → SSE」到底吃掉多少主线程
const w = 1606, h = 935
const buf = Buffer.alloc(w*h*4, 128)
console.log(`一帧 RGBA: ${(buf.length/1e6).toFixed(2)} MB`)

let t = Date.now()
for (let i = 0; i < 10; i++) buf.toString('base64')
const b64 = (Date.now()-t)/10
console.log(`base64 编码一帧: ${b64.toFixed(1)} ms -> 10fps 时每秒 ${(b64*10).toFixed(0)} ms 主线程`)

const s = buf.toString('base64')
t = Date.now()
const enc = new TextEncoder()
for (let i = 0; i < 10; i++) enc.encode(`event: frame\ndata: ${s}\n\n`)
const encMs = (Date.now()-t)/10
console.log(`拼 SSE 文本 + UTF-8 编码一帧: ${encMs.toFixed(1)} ms -> 10fps 时每秒 ${(encMs*10).toFixed(0)} ms`)

console.log(`合计每秒占用主线程: ${((b64+encMs)*10).toFixed(0)} ms  (1000ms 就是满载)`)

// 客户端那边 atob + 逐字节循环
t = Date.now()
const bin = Buffer.from(s, 'base64').toString('latin1')
const arr = new Uint8ClampedArray(bin.length)
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
console.log(`浏览器端 atob+逐字节复制一帧: ${(Date.now()-t).toFixed(1)} ms`)

/**
 * lib/host.mjs —— 原生后端的宿主侧封装：worker 生命周期 + 命令往返 + 抓帧队列
 * ============================================================================
 * 这一层只做「跟 worker 说话」，不认识 DSH 也不认识游戏语义：
 *   - worker 用 Electron 的 node 跑（DSH 自己是 Electron，spawn 出来的是 MEDIUM 权限，
 *     而 pwsh 工具是 LOW —— 这条是插件能发按键的前提，已实测）
 *   - 命令用自增 id 配对；超时/worker 崩溃都要让调用方拿到明确错误，不能挂死
 *   - 抓帧串行化：GDI 抓帧不是线程安全的，且并发抓帧只会互相抢 DC
 * ============================================================================
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND = join(HERE, 'win-backend.mjs')

export class NativeBackend {
  constructor(opts = {}) {
    this.opts = opts
    this.worker = null
    this.ready = null
    this.pending = new Map()
    this.seq = 0
    this.dead = false
    this.lastError = ''
    this.koffi = ''
    this.koffiOk = false
    this.captureChain = Promise.resolve()
  }

  /** 起 worker 并等它自报就绪 */
  start() {
    if (this.ready) return this.ready
    this.dead = false
    this.ready = new Promise((resolve, reject) => {
      let settled = false
      const worker = new Worker(BACKEND, { workerData: {}, env: { ...process.env } })
      this.worker = worker
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('原生后端 15 秒内没有就绪（koffi 加载失败？）'))
      }, 15_000)
      worker.on('message', (msg) => {
        // 首条 ready 消息
        if (!settled && msg && msg.ready) {
          settled = true
          clearTimeout(timer)
          this.koffi = msg.koffi || ''
          this.koffiOk = !!msg.koffiOk
          resolve({ koffi: this.koffi, koffiOk: this.koffiOk })
          return
        }
        const waiter = this.pending.get(msg?.id)
        if (waiter) {
          this.pending.delete(msg.id)
          waiter.resolve(msg)
        }
      })
      worker.on('error', (err) => {
        this.dead = true
        this.lastError = String(err?.message || err)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`原生后端启动失败：${this.lastError}`))
        }
        // 所有在途命令立刻失败，别让调用方等到超时
        for (const [, w] of this.pending) w.reject(new Error(`原生后端崩了：${this.lastError}`))
        this.pending.clear()
      })
      worker.on('exit', (code) => {
        this.dead = true
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`原生后端退出（code ${code}）`))
        }
        for (const [, w] of this.pending) w.reject(new Error(`原生后端退出（code ${code}）`))
        this.pending.clear()
      })
    })
    return this.ready
  }

  /** 发一条命令，等回包 */
  async call(cmd, timeoutMs = 8000) {
    if (this.dead) throw new Error(`原生后端不可用：${this.lastError || '已停止'}`)
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`原生后端 ${cmd.cmd} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.worker.postMessage({ ...cmd, id }) }
      catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  /**
   * 抓帧，串行化（GDI 不是线程安全的）。
   * format='rgba' 时 worker 里已经转好颜色并按 maxWidth 缩过（省主线程 CPU）。
   * @returns {Promise<{ok:boolean, width:number, height:number, data:Buffer, ms:number, error?:string}>}
   */
  async capture(hwnd, mode = 'printwindow', opts = {}) {
    const { format = 'rgba', maxWidth = 0 } = opts
    const run = async () => {
      const res = await this.call({ cmd: 'capture', hwnd, mode, format, maxWidth }, 15_000)
      if (!res.ok) return { ok: false, error: res.error }
      const data = Buffer.from(res.data)
      return { ok: true, width: res.width, height: res.height, ms: res.ms, scaledFrom: res.scaledFrom, data }
    }
    // 排队，保证同一时刻只有一次 GDI 抓帧
    const p = this.captureChain.then(run, run)
    this.captureChain = p.then(() => {}, () => {})
    return p
  }

  async find(exe = 'ICEY.exe') {
    return this.call({ cmd: 'find', exe }, 10_000)
  }

  async focus(hwnd) {
    return this.call({ cmd: 'focus', hwnd }, 6000)
  }

  /** 当前前台窗口（动作结束后要把焦点还回去） */
  async getForeground() {
    return this.call({ cmd: 'getfg' }, 5000)
  }

  async keydown(key) { return this.call({ cmd: 'keydown', key }, 5000) }
  async keyup(key) { return this.call({ cmd: 'keyup', key }, 5000) }
  async tap(key, ms = 60) { return this.call({ cmd: 'tap', key, ms }, ms + 5000) }
  async releaseAll() { return this.call({ cmd: 'releaseall' }, 5000) }
  async keystate(key) { return this.call({ cmd: 'keystate', key }, 5000) }
  async alive(hwnd) { return this.call({ cmd: 'alive', hwnd }, 5000) }

  /** 停 worker：先尽力松开所有键，再 terminate */
  async dispose() {
    const w = this.worker
    if (!w) return
    try { await this.releaseAll() } catch { /* 已经死了就算了 */ }
    this.worker = null
    this.ready = null
    this.dead = true
    try { await w.terminate() } catch { /* 忽略 */ }
  }
}

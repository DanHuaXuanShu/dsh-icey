/**
 * dsh-icey 网页半 —— 侧栏「艾希」面板 + 设置页
 * ============================================================================
 * ⚠️ client bundle **不是 ESM**，是自注册脚本：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *    id 必须等于 package.json 的 name，对不上就是
 *   "1 entry did not activate — loaded without registering <包名>"。
 *
 * 面板长什么样（用户要的是「能自己上手玩」，不是看日志）：
 *   ┌───────────────────────────────────────┐
 *   │ [接上游戏] [▶ 实时画面 开/关]   状态灯 │
 *   ├───────────────────────────────────────┤
 *   │                                       │
 *   │      canvas 实时画面（零编码直传）      │
 *   │                                       │
 *   ├───────────────────────────────────────┤
 *   │  虚拟手柄：WASD / J I L / 空格 / Esc   │
 *   └───────────────────────────────────────┘
 *
 * 实时画面怎么来的：SSE 每帧一段 base64 RGBA，canvas.putImageData 直接画。
 * 服务端**零编码**（不做 JPEG/PNG），所以 10fps 也不吃 CPU。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-icey',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PACKAGE_NAME = 'dsh-icey'
    const PANEL_ID = 'icey'
    const API = '/api/dsh-icey'

    /* ---------------- 样式 ---------------- */

    const CSS = `
[data-icey-page]{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
[data-icey-bar]{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}
[data-icey-title]{font-weight:600;font-size:13px;letter-spacing:.02em;margin-right:auto;display:flex;align-items:center;gap:6px;}
[data-icey-dot]{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto;}
[data-icey-dot][data-on="1"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 6px var(--dsw-alias-state-success-primary);}
[data-icey-dot][data-warn="1"]{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 6px var(--dsw-alias-state-warn-primary);}
[data-icey-btn]{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer;line-height:1.6;}
[data-icey-btn]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}
[data-icey-btn]:disabled{opacity:.45;cursor:not-allowed;}
[data-icey-btn][data-primary="1"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600;}
[data-icey-btn][data-primary="1"]:hover:not(:disabled){filter:brightness(1.08);}
[data-icey-screen]{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#0b0d10;overflow:hidden;}
[data-icey-screen] canvas{max-width:100%;max-height:100%;display:block;image-rendering:auto;}
[data-icey-empty]{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;padding:24px;}
[data-icey-foot]{padding:6px 10px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);line-height:1.6;}
[data-icey-err]{color:var(--dsw-alias-state-error-primary);}
[data-icey-fps]{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary);}
`

    /* ---------------- 小工具 ---------------- */

    const asJson = async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 设置页的行样式（内联，省得为一页加几十行 CSS） */
    const ROW = { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '12px' }
    const LABEL = { minWidth: '160px', color: 'var(--dsw-alias-label-secondary)' }
    const HINT = { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' }
    const INPUT = {
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '5px',
      padding: '3px 6px',
      fontSize: '12px',
      width: '90px',
      fontFamily: 'inherit',
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, payload) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }))

    /* ---------------- 实时画面 ---------------- */

    /**
     * 实时画面：**二进制帧**，不是 SSE、不是 base64。
     *
     * 服务端每帧推 16 字节头 + 原始 RGBA（'ICYF' + w + h + len）。
     * 这里用 fetch 的 body reader 累积字节、切帧、直接 putImageData。
     *
     * 🔴 为什么不用 EventSource：一帧 6MB 变 base64 是 8MB 字符串，
     *    atob + 逐字节复制实测 41ms/帧，10fps 就是 410ms/秒卡在浏览器主线程上，
     *    整个 DSH 界面都会卡。二进制路径是零拷贝 + 一次 putImageData。
     *
     * ⚠️ 一定要让浏览器"拉"：服务端是 pull 模式，浏览器读得慢服务端就不抓帧。
     */
    function useLiveScreen(active) {
      const canvasRef = useRef(null)
      const [size, setSize] = useState(null)
      const [fps, setFps] = useState(0)
      const [error, setError] = useState('')
      const frameCount = useRef(0)

      useEffect(() => {
        if (!active) { setFps(0); return }
        let closed = false
        let reader = null
        let abort = null
        let lastAt = Date.now()
        // 累积缓冲：网络给的 chunk 不保证对齐到帧
        let pending = new Uint8Array(0)

        const paint = (rgba, w, h) => {
          const canvas = canvasRef.current
          if (!canvas) return
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
            setSize({ width: w, height: h })
          }
          const c2d = canvas.getContext('2d')
          if (!c2d) return
          // 注意：putImageData 要求 ImageData 的数据长度正好是 w*h*4
          c2d.putImageData(new ImageData(rgba, w, h), 0, 0)
          frameCount.current++
        }

        const consume = () => {
          // 尽量把缓冲里完整的帧都画掉
          while (pending.length >= 16) {
            const magic = String.fromCharCode(pending[0], pending[1], pending[2], pending[3])
            const view = new DataView(pending.buffer, pending.byteOffset, 16)
            const w = view.getUint32(4, true)
            const h = view.getUint32(8, true)
            const len = view.getUint32(12, true)
            if (pending.length < 16 + len) return
            const body = pending.subarray(16, 16 + len)
            if (magic === 'ICYF' && w > 0 && h > 0 && len === w * h * 4) {
              try {
                // slice 出独立 buffer：ImageData 不接受共享的 subarray 视图
                paint(new Uint8ClampedArray(body.slice().buffer), w, h)
                setError('')
              } catch (e) {
                setError(`画面解码失败：${e?.message || e}`)
              }
            } else if (magic === 'ICYE') {
              try { setError(new TextDecoder().decode(body)) } catch { /* 忽略 */ }
            }
            pending = pending.subarray(16 + len)
          }
        }

        const run = async () => {
          try {
            abort = new AbortController()
            const res = await fetch(`${API}/stream`, { credentials: 'same-origin', signal: abort.signal })
            if (!res.ok || !res.body) {
              setError(`画面流打不开（HTTP ${res.status}）`)
              return
            }
            reader = res.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (closed || done) break
              if (!value || !value.length) continue
              // 拼到累积缓冲尾部
              const merged = new Uint8Array(pending.length + value.length)
              merged.set(pending, 0)
              merged.set(value, pending.length)
              pending = merged
              consume()
            }
          } catch (e) {
            if (!closed) setError(`画面流断了：${e?.message || e}`)
          }
        }

        void run()
        const tick = setInterval(() => {
          const now = Date.now()
          const dt = (now - lastAt) / 1000
          setFps(Math.round(frameCount.current / Math.max(dt, 0.001)))
          frameCount.current = 0
          lastAt = now
        }, 1000)

        return () => {
          closed = true
          clearInterval(tick)
          try { abort?.abort() } catch { /* 已关 */ }
          try { reader?.cancel() } catch { /* 已关 */ }
          setFps(0)
        }
      }, [active])

      return { canvasRef, size, fps, error }
    }

    /* ---------------- 主面板 ---------------- */

    function Panel() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [live, setLive] = useState(false)
      const [msg, setMsg] = useState('')
      const { canvasRef, size, fps, error: streamError } = useLiveScreen(live)

      const refresh = useCallback(async () => {
        try {
          const st = await jget('/status')
          setStatus(st)
        } catch (e) {
          setMsg(`读状态失败：${e.message}`)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])
      // 面板一打开就自己接一次：游戏已经在跑的话，用户不用点任何按钮就能看到画面。
      // 只做 attach（不启动游戏），失败就静静等着 —— 绝不在用户没要求时去拉游戏。
      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const cur = await jget('/status')
            if (cancelled || cur.running) return
            const res = await jpost('/attach', {})
            if (cancelled || !res.attached) return
            setLive(true)
            await refresh()
          } catch { /* 没接上就算了，按钮还在 */ }
        })()
        return () => { cancelled = true }
      }, [refresh])
      // 2 秒轮询状态：面板开着的时候要能看到游戏关了/最小化了
      useEffect(() => {
        const t = setInterval(() => { void refresh() }, 2000)
        return () => clearInterval(t)
      }, [refresh])

      /**
       * 主按钮：**接上，接不上就启动**。
       * 为什么这么设计：以前点它只做 attach，游戏没开时服务端会静默等窗口 60 秒 ——
       * 用户看到的就是「点了没反应、游戏打不开」。现在：
       *   ① 先试 attach（游戏已经在跑就秒连）
       *   ② 没接上 ⇒ 直接 direct 启动（窗口化），并明确告诉用户在等什么
       */
      const doStart = async () => {
        setBusy('start'); setMsg('正在找游戏窗口…')
        try {
          let res = await jpost('/attach', {})
          if (res.attached) {
            setMsg('接上了')
            setLive(true)
          } else {
            setMsg('游戏没开着，正在启动…（Unity 加载要 10–30 秒）')
            res = await jpost('/launch', { mode: 'direct', waitMs: 60000 })
            if (res.ok === false) {
              setMsg(res.error || '启动失败')
            } else {
              setMsg(`接上了（${res.rect ? `${res.rect.width}x${res.rect.height}` : '窗口已就绪'}）`)
              setLive(true)
            }
          }
          await refresh()
        } catch (e) {
          setMsg(`接不上：${e.message}`)
        } finally { setBusy('') }
      }
      /** 只接窗口：不启动，游戏没开就明确说找不到 */
      const doAttach = async () => {
        setBusy('attach'); setMsg('正在找游戏窗口…')
        try {
          const res = await jpost('/attach', {})
          if (res.attached) { setMsg('接上了'); setLive(true) }
          else setMsg(res.reason || '没找到游戏窗口 —— 游戏是不是没开？用左边的「接上游戏」可以直接启动它。')
          await refresh()
        } catch (e) { setMsg(`接不上：${e.message}`) } finally { setBusy('') }
      }
      const doStop = async () => {
        setBusy('stop')
        try {
          await jpost('/release', {})
          setLive(false)
          setMsg('已松开所有键')
          await refresh()
        } catch (e) { setMsg(e.message) } finally { setBusy('') }
      }

      const running = !!status?.running
      const canAct = !!status?.canAct
      const reason = status?.health?.reason || ''
      const dot = running ? (canAct ? '1' : '0') : '0'
      const dotWarn = running && !canAct ? '1' : '0'

      return h('div', { 'data-icey-page': '' },
        h('div', { 'data-icey-bar': '' },
          h('div', { 'data-icey-title': '' },
            h('span', { 'data-icey-dot': '', 'data-on': dot, 'data-warn': dotWarn }),
            '艾希 ICEY'),
          h('span', { 'data-icey-fps': '' }, live ? `${fps} fps` : '画面关'),
          h('button', { 'data-icey-btn': '', 'data-primary': '1', disabled: !!busy, onClick: doStart },
            busy === 'start' ? '接上中…' : (running ? '重新接上' : '接上游戏')),
          h('button', { 'data-icey-btn': '', disabled: !!busy, onClick: doAttach, title: '只接上已经在跑的游戏窗口，不负责启动' }, '只接窗口'),
          h('button', { 'data-icey-btn': '', onClick: () => setLive((v) => !v), title: '打开/关闭实时画面（关掉就不抓帧，几乎不占 CPU）' }, live ? '关画面' : '开画面'),
          h('button', {
            'data-icey-btn': '', disabled: !!busy, onClick: doStop,
            title: '把所有还按着的键全部松开。动作出错/超时时键可能卡在按下状态，点这个兜底（不会断开连接，也不会关游戏）',
          }, '松开按键')),

        h('div', { 'data-icey-screen': '' },
          h('canvas', { ref: canvasRef, style: live && size ? {} : { display: 'none' } }),
          (!live || !size) ? h('div', { 'data-icey-empty': '' },
            !running
              ? h(React.Fragment, null,
                h('div', { style: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)' } }, '还没接上游戏'),
                h('div', null, '点下面这个按钮就行：游戏开着就直接接上，没开就帮你启动（Unity 加载要 10–30 秒）。'),
                h('button', {
                  'data-icey-btn': '', 'data-primary': '1',
                  style: { padding: '7px 18px', fontSize: '13px' },
                  disabled: !!busy,
                  onClick: doStart,
                }, busy === 'start' ? '正在接上…' : '接上游戏'),
                // 重要的反馈要显示在视线里，别只丢到最底下的脚注
                msg ? h('div', { 'data-icey-err': '', style: { maxWidth: '520px' } }, msg) : null)
              : h(React.Fragment, null,
                h('div', { style: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)' } }, live ? '正在取画面…' : '画面关着'),
                !canAct && reason ? h('div', { 'data-icey-err': '', style: { maxWidth: '520px' } }, reason) : null,
                h('button', { 'data-icey-btn': '', 'data-primary': '1', onClick: () => setLive(true) }, '开画面')))
            : null),

        // 这个面板是**看台**，不是手柄：玩交给 DSH（agent 调 icey_* 工具），人只负责看。
        // 想自己上手就关掉面板，直接去点游戏窗口（游戏本身一直归你）。

        h('div', { 'data-icey-foot': '' },
          streamError ? h('div', { 'data-icey-err': '' }, streamError) : null,
          msg ? h('div', { 'data-icey-err': '' }, msg) : null,
          !running
            ? '游戏没接上。'
            : (canAct
              ? 'DSH 可以操作了：直接跟它说「玩艾希」或者「往右走、打它」，它会自己按键。'
              : reason),
          status?.rect ? ` 窗口 ${status.rect.width}x${status.rect.height}，pid ${status.pid}。` : '',
          status?.backend && !status.backend.koffiOk ? ' ⚠️ koffi 不可用：只能看不能动。' : ''))
    }

    /* ---------------- 侧栏图标 ---------------- */

    function IceyIcon() {
      // 艾希的配色：冷蓝 + 黑。用 SVG 而不是 emoji，跟 DSH 自己的图标一套。
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 2.5 4.5 6.4v6.2c0 4.6 3.1 7.9 7.5 9 4.4-1.1 7.5-4.4 7.5-9V6.4L12 2.5Z',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M9.2 10.4 12 7.6l2.8 2.8-2.8 2.8-2.8-2.8Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M12 15.2v3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    /* ---------------- 设置页 ---------------- */

    /**
     * 设置页：**可直接改**。
     * 为什么不是只读：这台机器的 profile 树里没有 schemastery，DSH 的 bundle 配置页
     * 会显示「没有可配置字段」。所以插件自己提供一份能改的，改完写
     * $DSH_HOME/icey/config.json，立刻生效、不用重启。
     */
    function SettingsPanel() {
      const [cfg, setCfg] = useState(null)
      const [msg, setMsg] = useState('')
      const [savedTo, setSavedTo] = useState('')

      const load = useCallback(() => {
        jget('/config')
          .then((r) => { setCfg(r.config); if (r.storage?.path) setSavedTo(r.storage.path) })
          .catch((e) => setMsg(e.message))
      }, [])
      useEffect(() => { load() }, [load])

      const save = async (patch) => {
        try {
          const res = await fetch(`${API}/config`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          }).then((r) => r.json())
          if (!res.ok) { setMsg(res.error || '保存失败'); return }
          setCfg(res.config)
          setMsg('已保存，立刻生效')
          if (res.savedTo) setSavedTo(res.savedTo)
        } catch (e) { setMsg(`保存失败：${e.message}`) }
      }

      if (!cfg) return h('div', { 'data-icey-foot': '', style: { padding: '10px' } }, msg || '读配置…')

      const num = (key, label, hint, min, max) => h('div', { key, style: ROW },
        h('span', { style: LABEL }, label),
        h('input', {
          type: 'number', min, max,
          defaultValue: String(cfg[key] ?? ''),
          style: INPUT,
          onBlur: (e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v !== cfg[key]) void save({ [key]: v })
          },
        }),
        hint ? h('span', { style: HINT }, hint) : null)

      const bool = (key, label, hint) => h('label', { key, style: { ...ROW, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: !!cfg[key],
          style: { marginRight: '6px' },
          onChange: (e) => void save({ [key]: e.target.checked }),
        }),
        h('span', { style: { minWidth: '160px' } }, label),
        hint ? h('span', { style: HINT }, hint) : null)

      const text = (key, label, hint) => h('div', { key, style: ROW },
        h('span', { style: LABEL }, label),
        h('input', {
          type: 'text', defaultValue: String(cfg[key] ?? ''), style: { ...INPUT, minWidth: '320px' },
          onBlur: (e) => { if (e.target.value !== cfg[key]) void save({ [key]: e.target.value }) },
        }),
        hint ? h('span', { style: HINT }, hint) : null)

      return h('div', { 'data-icey-page': '', style: { padding: '10px 12px', height: 'auto', gap: '2px' } },
        h('div', { 'data-icey-foot': '', style: { padding: '0 0 8px' } },
          '改完立刻生效，不用重启。配置存在 ' + (savedTo || '$DSH_HOME/icey/config.json')),
        text('gameDir', '游戏目录', '有 ICEY.exe 的那一层'),
        text('exePath', 'exe 路径', '留空 = 游戏目录\\ICEY.exe'),
        h('div', { style: { ...ROW, gap: '8px' } },
          h('span', { style: LABEL }, '开游戏方式'),
          h('select', {
            defaultValue: String(cfg.launchMode),
            style: INPUT,
            onChange: (e) => void save({ launchMode: e.target.value }),
          }, ['attach', 'steam', 'direct'].map((m) => h('option', { key: m, value: m }, m))),
          h('span', { style: HINT }, 'attach=接上已开的窗口（推荐）')),
        num('fps', '画面帧率', '1–12', 1, 12),
        num('streamWidth', '画面宽度', '320–1280，越小越省 CPU', 320, 1280),
        num('maxFrameWidth', '截图宽度', '给模型的截图上限', 320, 1568),
        bool('allowFocus', '操作时抢前台', '关掉 = 只看不动（ICEY 只认前台按键）'),
        bool('restoreFocus', '动作后把焦点还回来', '建议开：否则玩一会儿 DSH 会被游戏压着'),
        msg ? h('div', { 'data-icey-err': '', style: { paddingTop: '6px' } }, msg) : null)
    }

    /* ---------------- 挂载 ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 🔴 整个 apply 必须不可能把 Web GUI 拖下水：任何一个 slot 注册失败都只让
        //    对应的那块不出现，绝不能让异常冒到 web boot（那会变成「DSH 打不开」）。
        const guarded = (what, fn) => {
          try { fn() } catch (e) {
            // 只打日志，不抛
            console.warn(`[dsh-icey] ${what} 挂载失败：`, e)
          }
        }

        guarded('样式', () => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', PACKAGE_NAME)
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'dsh-icey styles')
        })

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) {
          console.warn('[dsh-icey] 拿不到 slots 服务，面板不挂载（工具仍然可用）')
          return
        }

        // 主面板：key 必须跟 sidebar.panellist 的 id 对上，否则点了打不开
        guarded('主面板', () => {
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel))
        })
        guarded('侧栏入口', () => {
          slots.inject('sidebar.panellist', () => slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '艾希' },
            IceyIcon,
          ))
        })
        // 设置页（只是只读展示；真正改配置在「设置 → 插件 → 艾希」的 bundle 页）
        guarded('设置页', () => {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: PACKAGE_NAME, order: 40, label: '艾希' },
            SettingsPanel,
          ))
        })
      },
    }
  },
})

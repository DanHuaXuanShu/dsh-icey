# dsh-icey

让 DeepSeek Harness 的 agent **真的能玩《艾希 ICEY》**——不是模拟、不是读存档，是看真画面、按真按键。

侧栏里多一个「艾希」入口：打开就是游戏的**实时画面**，你负责看，DSH 负责玩。

> 面板上**没有虚拟手柄**（这个是刻意去掉的）：手动操作交给游戏窗口本身，
> 面板只做「看台」—— 想自己上手就关掉面板直接点游戏；想让 AI 玩就直接跟它说「玩艾希」。

---

## ⚠️ 给维护的人：这个包在 profile 里是「链接安装」，别去搬那个 Junction

开发时插件用 `link:` 装进 profile：

```
profile/package.json   "dsh-icey": "link:D:/dsh/ICEY插件"
profile/node_modules/dsh-icey   →  Junction（目录符号链接）→  D:\dsh\ICEY插件
```

这就是「改本地文件立刻生效」的原因，但也带来一个**已经真实踩过**的坑：

> ### 🔴 不要用 `Move-Item` / 资源管理器「剪切」去搬走 `node_modules\dsh-icey`
>
> Windows 的 `Move-Item` 对 Junction **会跟随重解析点**，把**目标目录的内容**一起搬走。
> 实测后果：把 `<profile>\node_modules\dsh-icey` 搬到备份目录之后，
> `D:\dsh\ICEY插件` 里的源码（index.js / lib / probe / shots …）**全被搬走了**，
> 源码目录只剩一个空壳 —— 而 DSH 界面上看起来只是「插件没了」，非常容易误判成「代码丢了」。
>
> **正确停用方式（任选一种，都不会碰目标目录）：**
>
> | 做法 | 命令 / 位置 |
> |---|---|
> | 插件管理里移除 | 设置 → 插件 → dsh-icey → 移除（pnpm 删除链接，不动目标） |
> | 装但不用 | `cordis.patch.yml` 加一行 `- id: dsh-icey` + `disabled: true` |
> | 只删链接本身 | `cmd /c rmdir "<profile>\node_modules\dsh-icey"`（**不要**加 `/s`） |
>
> **万一已经搬走了**：从备份目录把内容 `Copy-Item` 回 `D:\dsh\ICEY插件`（`Copy` 不跟随、可重复执行），
> 或者干脆从 npm 重装一份源码底稿：`npm pack dsh-icey@0.1.0` 解压即可（21 个文件，缺 `probe/` `shots/`）。

其它注意点：

- **别在插件目录里跑 `pnpm install`**：会把 `node_modules` 建到源码目录里，跟 profile 的那份混在一起。要装依赖用 `npm.cmd install <pkg> --no-save`，或干脆不加运行时依赖（现在就是零依赖）。
- `npm publish` 只发 `files` 白名单里的 21 个文件，`probe/`、`shots/`、`workbuddy/`、`RELEASING.md` 不会进包 —— 所以「本地有、npm 没有」是正常的。

---

## 只有一个插件条目（2026-10-22 改）

`cordis.patch.yml` 现在**只插一行** `dsh-icey`。以前是两行（`dsh-icey` + `dsh-icey/agent`），
结果插件列表里出现**两个标题完全相同的「艾希 ICEY」**，很难分辨。

原因是宿主的规则：行的标题取 `row.meta?.title ?? row.moduleName`，而 `metaOf()` 是**按包**取
locale 的 `meta.title` —— 同一个包的两行，标题必然一样。

合并后：

| 原来 | 现在 |
|---|---|
| `dsh-icey`：路由 + 配置 | 同一个入口，全部由 `index.js` 负责 |
| `dsh-icey-agent`：6 个工具 | `index.js` 末尾 import `agent.js` 并调它的 `apply()` |

**优雅降级没有丢**：不再靠 Loader 的 `inject` 决定装不装，而是在运行时用
`ctx.get('tools')` / `ctx.get('attachments')` 探测 —— 缺服务就只跳过工具，面板和路由照常。

`package.json` 仍导出 `"./agent": "./agent.js"`，留给「以后想把工具单独挂到某个 agent 预设」的场合。

---


## 它到底怎么做到的（以及为什么只能这么做）

三件事都是实测出来的，不是设计时的假设：

### 1. 按键：只有 `SendInput` 有用，而且必须在前台

ICEY 是 Unity 5.4 游戏，走 Raw Input / `GetAsyncKeyState`。它**完全无视 `WM_KEYDOWN`** —— 前台发、后台发都试过，画面一动不动。只有 `SendInput` 有效，而且**只对前台窗口有效**。

所以插件的「操作」= 抢前台 + `SendInput`。代价是**会打断你正在做的事**（切走你的窗口）。这个代价必须让你知道，所以：

- `allowFocus` 关掉 ⇒ 插件只抓画面，一次都不抢焦点（但也就按不动）
- `icey_status` 会如实写「现在能不能操作」和原因，不会假装成功

> 另外实测：**ICEY 自己也会抢焦点**（它会把前台抢回去）。所以插件不能假设「刚才抢到了现在还在」，每次动手前都重新确认一次。

### 2. 抓帧：`PrintWindow` + `PW_RENDERFULLCONTENT`

D3D11 窗口用普通 `BitBlt` 会抓到**全黑**。必须 `PrintWindow(hwnd, dc, 2)`。最小化时两种都抓不到（不过游戏大约 15 秒会自己把窗口还原）。

### 3. 抓帧和颜色转换都在 worker 线程里

一帧 1606×935 是 ~6MB。走子进程 stdin/stdout 就是每帧 6MB 序列化 —— 10fps 就是 60MB/s，不现实。所以后端跑在 **`worker_threads` 里**，帧数据用 ArrayBuffer **转移**（零拷贝），`BGRA→RGBA` 和缩放也在 worker 里做完，主线程只转手。

---

## 给 agent 的 6 个工具

| 工具 | 干什么 |
|---|---|
| `icey_start` | 接上/启动游戏，返回能不能操作 + 首帧截图 |
| `icey_status` | 窗口、pid、前台状态、动作队列、后端健康 |
| `icey_look` | 看一眼现在画面（缩到 1280 宽省 token） |
| `icey_screenshot` | 高清截图（看小字、菜单高亮） |
| `icey_act` | move / dash / attack / heavy / execute / jump / interact / pause / menu |
| `icey_stop` | 松键 + 停止接管（**不关游戏**） |

失败一律返回 `{ ok: false, error, hint }`，**绝不抛异常**——抛了模型就看不到原因。

### 关于「动作生效了没」

`icey_act` 会抓前后两帧算差异，但它**在返回里明说**：ICEY 待机本身也有动画（实测 1.5 秒差 0.47%），所以「画面变了」不等于「你的按键生效了」。要确认角色真响应了，得看画面里角色的位置/朝向，或者连做两次同一动作对比。

---

## 规则卡：`icey_playbook`

模型不知道 ICEY 的坑（哪些数字代表进展、哪扇门开不了、菜单里哪个键会退出游戏），
每次都靠试错，代价是几十秒真机时间和几次误操作（**真的把游戏退掉过一次**）。
所以把实测结论固化成了规则卡：

```js
icey_playbook({})                  // 完整版（约 1000 字）
icey_playbook({ format: 'compact' })  // 4 行精华，省 token
```

也可以直接取：`GET /api/dsh-icey/playbook`（markdown），`?format=compact` 取精华。

规则卡的结构参考了 [GameScaling](https://github.com/THUSI-Lab/GameScaling) 的系统提示写法
（`Game Rules` / `Common Keys` / `Output Format` / 说明），内容全部来自本机实测：

| 段 | 内容举例 |
|---|---|
| **Game Rules** | 左上角是血条+连击、右上角是钱；靠近可互动物会浮出白字提示框；有些门是剧情锁 |
| **Common Keys** | W/S/A/D 移动、J 攻击、I 重击、L 处决、空格跳、Enter 互动/确认、Esc 暂停 |
| **怎么判断真进展** | 海拔/坐标数字变了、画面整体横移、$ 变大；原地小幅抖动 = 被挡住 |
| **危险动作** | 菜单里的「退出」也是用 Enter 选的（实测把游戏退掉过）→ 盲按确认键每次连玩限 3 次 |

> 顺带那个项目里最有用的一条指令是：**「局面没变就直接出动作，只在明显变化时才思考」**。
> 这也是 `icey_play` 的设计原则 —— 它只在 `events` 里汇报值得注意的变化，不逐帧说话。

---

## 自主连玩：`icey_play`（一次调用玩一段）

前面 6 个工具都是「你做一步、我看一眼」。`icey_play` 是**反过来**的：
**一次调用跑完一整段**，中途不再问你，结束后汇报「做了什么、途中发生了什么、几张关键截图」。

```js
icey_play({ seconds: 30, preset: 'advance', captureEvery: 12, maxFrames: 3 })
```

| preset | 行为 |
|---|---|
| `advance`（默认） | 往右推进 + 节奏性挥刀，卡住就按确认键 |
| `fight` | 原地连打：重击/普攻交替，偶尔冲刺 |
| `explore` | 走得更久、偶尔跳、少打架 |

### 它靠什么决策（**没有视觉理解**，这点必须说清）

三个信号 + 一条脱困阶梯，都很便宜：

| 信号 | 怎么算 | 拿来判断什么 |
|---|---|---|
| `hudBright` | 左上 HUD 区域里**亮像素**的占比 | 太低（≈0%）⇒ **还没进游戏**（标题/加载/过场）→ 按确认键推进 |
| `motion` | 相邻两帧的差异比例 | 几乎不动 ⇒ 被对话框/菜单挡住 |
| `progress` | 跟 **2.5 秒前**那帧比 | 太低 ⇒ **原地踏步**（被门/墙挡住）|
| `hudKick` | HUD 区域亮度变化 | 在跳 ⇒ 在打架 → 加大攻击频率 |

后两个是最难的部分，也是 2026-10-23 真机踩出来的：

> **只看相邻帧的 `motion` 会被待机动画骗过去。**
> 标题界面有飘雪（motion 1.5–2%），策略以为"画面在动"，一直走路挥刀却从不按 Enter，
> **永远进不了游戏**；卡在大门前也一样，白按了 15 秒。
> 所以补了 `hudBright`（判断在不在游戏里）和 `progress`（判断有没有真进展）。

卡住时的**脱困阶梯**（挨个试，不撞同一面墙）：

```
退一步 → 按确认 → 跳 → 重击 → （一轮都失败）→ 掉头走另一条路
```

判定连续失败用的计数是**衰减**不是清零（撞一下、相机抖一下、又停住的锯齿，
清零会让阶梯永远走不到「掉头」——真机实测过：40 秒里只按了 4 次确认键）。
连着 5 轮都没进展 ⇒ **主动停下，把画面交回**，由模型/人判断这里到底是什么。

### 怎么分辨「这扇门打不开」

先说结论：**插件不做像素级的门禁识别，因为实测不可靠。**

试过的方法和结果（都有记录）：

| 想法 | 实测结果 |
|---|---|
| 靠「画面几乎不动」判断卡住 | ❌ 标题界面有飘雪（motion 1.5–2%），卡在门前也有待机动画 → 一直以为在前进 |
| 靠「2.5 秒净进展」判断卡住 | ✅ 有效（正常走路 >50%，卡住 ~1.5%）|
| 靠「互动提示框」（「按 J: …」那个白字框）判断能不能开 | ❌ 8 段靠近采样里提示框都是 0%（只在特定时机出现），**不能拿它当判据** |

参考项目 [THUSI-Lab/GameScaling](https://github.com/THUSI-Lab/GameScaling)（米哈游 × 清华的
游戏智能体）的做法是把这件事交给**训练过的 VLM**：每帧看图，输出 200ms 的键鼠动作块。
我们这里没有那个模型权重，[gm-autoplayer](https://github.com/sugeesh/gm-autoplayer) 的做法是
**本地反射 + 模型当策略**（hybrid）。所以这个插件按同样的分工来：

- **插件（反射）**：发现没进展 → 按阶梯试一遍交互 → 还不行就**判定这条路走不通，掉头**
- **模型（策略）**：读 `icey_play` 返回的摘要 + 截图，决定「这扇门是不是要等剧情/需要别的办法」

`icey_play` 返回里的 `events` 会写明：「第 N 秒 这处过不去（可能锁住的门/解谜）→ 掉头探索另一边」。
看到这条，就该自己看一眼截图再决定，而不是继续硬撞。

> ⚠️ **盲按确认键是真有风险的**：ICEY 的暂停菜单里「退出」也是用确认键选的。
> 实测发生过一次——菜单开着时光标停在「退出」，策略按了 Enter，**游戏被退掉了**。
> 所以现在每次连玩最多盲按 **3 次**确认键（`MAX_INTERACTS`），超了就改用跳/重击。

### 真机实测（2026-10-23）

```
icey_play({seconds: 30}) → {move:24, attack:24, heavy:5}，从「时计塔内」走到带标记的大门口
icey_play({seconds: 25}) → {move:28, attack:12, heavy:4, interact:1}
                           events: ["第 13s 卡住了，按了确认键"]
icey_play({seconds: 40}) → {move:40, attack:21, interact:4, jump:1, heavy:6}
```

也就是说：**能自己走路、打架、发现卡住并换招**；那扇需要特定操作的门它开不了 ——
按设计它会判定「走不通」、掉头、并在摘要里说明，把判断权交回模型。

### 安全边界

- 连玩期间**只在开始时抢一次前台**，结束时统一还原（不是每按一次键就把焦点丢回给你，那样窗口会来回闪）
- 任何路径结束都会 `releaseAll()` 松键 —— 连崩溃/停止插件都不会留卡键
- 同一个游戏同时只允许一个连玩任务
- 中途截图默认 3 张（每张都花 token），`maxFrames: 0` 可以完全不要

### 想验证它（不开游戏也能测）

```bash
node probe/play-loop-check.mjs     # 假后端跑完整循环：会推进、会卡住自停、不留卡键
node probe/autoplay-check.mjs 25   # 真机：接上已开着的 ICEY 玩 25 秒，存截图
node probe/hud-probe.mjs           # 量 HUD 特征（调阈值时用）
```

`play-loop-check` 把原生后端换成「合成帧 + 只记录按键」的假后端，**真的调用 `play()`**，
所以验的是我们自己的编排逻辑（循环、超时、松键、焦点还原、参数夹紧），不是游戏本身。
`selfcheck.mjs` 里另有 18 项针对信号与阶梯的纯逻辑测试。CI 里都会跑。

---

## 面板（看台，不是手柄）

侧栏「艾希」→

```
┌────────────────────────────────────────┐
│ ● 艾希 ICEY   9 fps  [接上游戏] [只接窗口] [开画面] [松键] │
├────────────────────────────────────────┤
│                                        │
│        canvas 实时画面（二进制帧直传）    │
│                                        │
├────────────────────────────────────────┤
│ DSH 可以操作了：直接跟它说「玩艾希」…    │
└────────────────────────────────────────┘
```

**没有虚拟手柄**（刻意去掉的）：手动操作交给游戏窗口本身，面板只负责让你看它玩。
想让 AI 玩就直接跟它说「玩艾希」「往右走」「打它」；想自己上手就关掉面板去点游戏。

实时画面走 **二进制帧**（`ICYF` 头 + 原始 RGBA），不是 SSE、不是 base64：
浏览器用 `fetch` 的 body reader 累积字节直接 `putImageData`，服务端只 enqueue Buffer。
**拉模式**：浏览器不读就不抓帧，面板一关 CPU 立刻归零。


---

## 配置

「设置 → 插件 → 艾希」，全部字段 `volatile`，改完**不用重启**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `launchMode` | `attach` | `attach` 接已开的窗口（最稳）/ `steam` / `direct` |
| `gameDir` | `D:\SteamLibrary\steamapps\common\ICEY` | 有 `ICEY.exe` 的那一层 |
| `exePath` | 空 | 直接指定 exe；留空用 `gameDir\ICEY.exe` |
| `fps` | `10` | 面板帧率，1–15 |
| `captureMode` | `printwindow` | `bitblt` 只在前者失败时试 |
| `inputBackend` | `sendinput` | `postmessage` 实测无效，留作排查 |
| `allowFocus` | `true` | 关掉 = 只看不动 |
| `maxFrameWidth` | `1280` | 给模型的截图宽度 |
| `windowedFix` | `true` | `direct` 启动时加窗口化参数 |

---

## 键位

来自游戏自己的 PlayerPrefs（`HKCU\Software\Shanghai FantaBlade Network Technology Co., Ltd.\ICEY`），不是猜的：

`W/S/A/D` 移动 · `J` 攻击 · `I` 重击 · `L` 处决 · `空格` 跳 · `Enter` 互动/确认 · `Esc` 暂停 · `O` 闪现 · `U` 追击 · `8`/`9` 特殊技

可以在配置的 `keyMap` 里改。

---

## 边界（明确不做的事）

- **不读游戏内存、不注入 DLL、不改存档**——只做「看窗口 + 发按键」，跟人坐在这儿玩一模一样
- **不依赖 `computer_*` 工具**——那套是给通用桌面操作用的，插件自己抓帧更快更准（而且不会误抓标题里带 ICEY 的 chrome 窗口）
- **不关用户的游戏**——`icey_stop` 只停止接管

---

## 自检

```bash
node selfcheck.mjs
```

47 项：PNG 编码/解码往返、像素加工、控制映射、动作队列、Config 归一化。不需要 DSH、不需要游戏在跑。

---

## 已知问题与修复记录

### 2026-10-21 修复：「开了艾希之后 DSH 不能用」

三个独立的真问题，都会让人感觉「插件把 DSH 搞坏了」：

1. **抢前台后不还焦点**
   按键必须把游戏抢到前台（ICEY 只认前台输入），但旧版用完**不还** —— DSH 就一直是后台窗口，点不动、打不了字。
   现在每个动作都记着「动作前是谁在前台」，做完**还回去**（`restoreFocus`，默认开）。

2. **抢前台时做了 TOPMOST → NOTOPMOST 抖动**
   如果后一步没成功，ICEY 就**永久置顶**，把 DSH 整个盖住。
   这段已经删掉：宁可少抢到一次前台（会如实报错），也绝不留下置顶状态。
   实测抢完 / 还完后 ICEY 的扩展样式里没有 `WS_EX_TOPMOST` 残留。

3. **实时画面用 SSE + base64 推原始分辨率**
   一帧 1606×935 的 RGBA 是 6 MB，base64 后 8 MB。实测光在宿主主线程上编码 + 拼串就
   **147 ms/秒**（10fps），浏览器那边 `atob` + 逐字节复制还要 **41 ms/帧** ⇒ 整个 Web GUI 卡死。
   现在改成：**960 宽（2.15 MB/帧）+ 二进制帧（不 base64）+ 拉模式**
   （没人拉就不抓帧，面板一关 CPU 立刻归零）。浏览器侧 0 次 `atob`、0 次逐字节循环。

### 2026-10-21 修复（第二轮）：面板按钮看不见、点了没反应

1. **主按钮白底白字** —— 这个主题里 `--dsw-alias-brand-primary` 是浅色，按钮又写了 `color:#fff`，
   于是文字和背景一个色 ⇒ 按钮是"空"的。改成 `color: var(--dsw-alias-bg-base)`，深浅主题都对比得住。
2. **点「接上游戏」没反应** —— 旧逻辑只做 attach；游戏没开时服务端会**静默等窗口 60 秒**，
   用户看到的就是"点了没反应、游戏打不开"。现在：
   - `/launch` 在 attach 失败时**立刻**返回（<200 ms）并说清原因
   - 面板的主按钮是"接上，接不上就启动"：先 attach，没接上就 `direct` 启动并提示在等什么
3. **接得太早** —— Unity 会先开一个 **320×240 的启动窗**，几秒后才长成正常分辨率。
   以前"窗口一存在就接"，抓到的是启动窗。现在要求宽度 ≥ 640 才接。
   冷启动实测：**2.3 秒**从"游戏没开"到"接上 1606×935"。
4. **句柄失效后不会自愈** —— `direct` 启动时 Unity 会**再 fork 一次**，
   我们最初拿到的 pid/hwnd 随第一个进程退出而失效，游戏却还在（新 pid + 新 hwnd）。
   旧版会一直报"游戏已退出"，可屏幕上游戏明明开着。现在 `status / look / act` 都会先自愈重接。
5. 面板一打开会**自己 attach 一次**（不启动游戏），已经在跑的游戏不用点任何按钮就能看到画面。

### `icey_act schema 无效`

`dsh-tools` 拿不到时用的是插件自带的等价实现，早期版本把参数原样交给宿主 ——
但 `{ action: { required: true } }` 是 `dsh-tools` 的私有写法，**不是合法 JSON Schema**
（合法写法是对象级 `required: ["action"]`）。这个错只在**模型调工具时**才报，安装阶段看不出来。
现在兜底实现会做 spec → JSON Schema 转换，并且 `probe/schema-check.mjs` 会把 6 个工具
的 schema 逐个当合法 JSON Schema 校验一遍。

**2026-10-21 19:4x 复核（DSH 0.2.1-rc.2，WorkBuddy 报的那条）**：把宿主**真正的**校验器
（`dsh-tools/json-schema`）从 `app.asar` 切出来跑了一遍，见 `probe/dsh-jsonschema.mjs` 头部：

- 6 个工具的 `parameters` / `output.schema` **全部通过**；旧写法会被判红，报错原话
  `schema.properties.action.required is not supported on type "string"` —— 与当初的报错一致，
  说明校验器接对了（灵敏度自证在 `probe/schema-check.mjs` 里）。
- 这台机器实测 `dsh-tools` 仍然 `ERR_MODULE_NOT_FOUND` ⇒ **走的是本地兜底**，
  所以兜底路径必须产出标准 JSON Schema。现在按「谁家的 defineTool」分流
  （`parametersForDefineTool(params, localFallback)`）：
  - 本地兜底 → `toSchema()` 标准 JSON Schema（对象级 `required`，属性里没有 `required`）；
  - 宿主 defineTool → **原样 spec**（宿主自己转）。以前不分流、一律转成 schema，
    在「拿得到宿主 dsh-tools」的机器上会被当成参数表再包一层（参数全错）。
- ⚠️ **改完必须重启 DSH（或让插件重载）**：ESM 模块缓存不跨进程刷新 ——
  文件修了、旧进程还在跑旧模块，就会一直报同一句。这也是「明明改好了还报错」的常见原因。
- 复核：`node probe/schema-check.mjs`（直接跑宿主校验器 + 三条路径断言）。

### 其余已知问题

- **会抢焦点**：这是 ICEY 的输入方式决定的（它完全无视 `PostMessage`）。不想被抢就关 `allowFocus`。
- **面板大约 5–6 fps**：不是写死限速，是抓帧本身就慢（`PrintWindow` 抓 D3D11 窗口 ~80–150 ms）。
  抓帧慢的时候会自动放宽间隔，**绝不堆积**。觉得占 CPU 就把 `fps` 调低，不影响画面质量。
- **最小化抓不到画面**：游戏大约 15 秒会自己还原，插件会如实报「已最小化」。
- **`koffi` 拿不到时只能看不能动**：插件会降级并在 `icey_status` 里写明，不会静默假装能操作。
- **这台机器上 DSH 设置页没有艾希的可配置字段**：profile 树里没有 `@deepseek-ai/schemastery`，
  所以 `Config` 是 undefined。作为补偿，插件自己提供一份能改的配置页
  （侧栏「艾希」→ **设置 → 艾希**），改完写 `$DSH_HOME/icey/config.json`，立刻生效。

---

## 安全：这个仓库是公开的

仓库和 npm 包都是公开的，所以**绝不能把密钥带进来**。
2026 年 GitHub 上大面积出现硬编码 API key 泄漏（AI 服务的 key 同比 +81%），
最常见的原因就是 `.env` / `config.json` 被 `git add -A` 一起推了上去。

这个仓库为此做了三道防线：

1. **`.gitignore`** 覆盖 `.env*`、`*.pem`、`*.key`、`.npmrc`、`*.tgz`、`*.log`
2. **`probe/secret-scan.mjs`**：扫工作区 + git 历史里的密钥特征
   ```bash
   node probe/secret-scan.mjs            # 工作区
   node probe/secret-scan.mjs --history  # 连 git 历史一起
   node probe/secret-scan.mjs --all      # 含被 gitignore 的目录（本机自查）
   ```
3. **两道自动闸门**：`npm publish` 前会跑一次（`prepublishOnly`），
   GitHub Actions 发布前也会跑一次（扫历史）—— 命中就直接失败，不会发出去

> 记住那条铁律：**key 一旦推到公开仓库，就当作已经泄露**。
> 光删文件没用（历史里还在），必须去服务商后台作废并重新生成。

扫出来的东西如果真的推上去了，处理顺序是：
轮换密钥 → 用 `git filter-repo` 清历史 → 强制推送 → 通知所有协作者重新克隆。

---

## 排错用的探针

`probe/` 下每个脚本都是能直接跑的，不需要 DSH：

```bash
node probe/secret-scan.mjs       # 密钥扫描（工作区 / --history / --all）
node probe/schema-check.mjs      # 6 个工具的 schema 是否合法 JSON Schema
node probe/client-check.mjs      # 客户端自注册 / slot / 二进制帧解析
node probe/tool-check.mjs        # 真调 6 个工具（抓帧 + 按键都是真的）
node probe/stream-route-check.mjs # 跑真 /stream 路由，量与帧率
node probe/config-check.mjs      # 配置持久化往返
```

一键跑全部本地检查：`npm.cmd run check`


MIT

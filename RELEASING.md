# 发布 dsh-icey

这个包已经按 npm 公共包 + DSH bundle 的规范配好，**发到 npm 就是发布**。

---

## 🔴 先读这段：2026 年 npm 把「绕过 2FA 的 token」这条路关掉了

来源：[npm install-time security and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
（2026-07-08，GitHub Changelog）

时间线（按官方公告）：

| 时间 | 变化 |
|---|---|
| **2026-08 起** | 带 bypass 2FA 的 granular token **不能再做账号/包/组织管理**：创建 token、生成恢复码、改密码/邮箱/2FA、改包访问权限与维护者、改组织成员… |
| **2027-01 前后** | 这类 token **再也不能直接 publish**；只保留「读私有包」+「**暂存**一次发布」，要人用 2FA 批准后才真正公开 |

### 这解释了我们实际踩的坑（2026-10-21）

当时建了一个勾了 **Bypass two-factor authentication (2FA)** 的 granular token，`npm whoami` 能过，
但 `npm publish` 一直 403：

```
403 Two-factor authentication or granular access token with bypass 2fa enabled
    is required to publish packages.
```

**结论：别再指望长期 token 自动发布。** 现在（2026-10）可行的三条路，按推荐顺序：

#### ① 本地交互发布（我们现在用的，最简单）

```powershell
cd D:\dsh\ICEY插件
npm.cmd publish
# 看到 "Authenticate your account at: https://www.npmjs.com/auth/cli/..." 时按回车
# → 浏览器打开 → 用安全密钥确认 → 回到终端，命令自动继续
```

实测可行（2026-10-21 就是这样发出 0.1.0 的）。代价：每次发版要点一下浏览器。

> ⚠️ 我们当时为了让它跑通，还在账号里**关掉了**
> 「Require two-factor authentication for write actions」。
> **建议你回 npmjs.com → Account → Modify 2FA 把它重新勾上** ——
> 有安全密钥的情况下，发布走上面的浏览器确认即可，不需要长期关掉这个保护。

#### ② 暂存发布（Staged publishing）：自动构建 + 人工批准

适合以后上 CI：机器只能「暂存」，最后一步必须人用 2FA 批准。

```powershell
npm.cmd stage publish        # 推到暂存区，不公开
npm.cmd stage list           # 看暂存 id
npm.cmd stage view <id>      # 检查内容（能被别人看到的是什么）
npm.cmd stage approve <id>   # 人工 2FA 批准后正式发布
```

（2026-10-02 起，暂存发布**也支持创建全新包**了。）

#### ③ Trusted Publishing（OIDC）：CI 发布的正解

把发布交给 GitHub Actions，npm 用 OIDC 验证「这次发布确实来自这个仓库的这个 workflow」，
**完全不需要长期 token**。这是 npm 官方给自动化的推荐路线，也是 2027 年之后唯一可持续的自动化方式。

---

## 另一个变化：npm v12 默认关掉了 install 期脚本

npm v12（现在是 `latest`，本机还是 11.19.0）默认：

- `allowScripts` **关**：依赖的 `preinstall`/`install`/`postinstall`、隐式 node-gyp 构建都不再自动跑
- `--allow-git` / `--allow-remote` 默认 **none**：git 依赖、远程 URL 依赖不再自动解析

**对 dsh-icey 没有影响**：这个包 `dependencies` 是空的，只有两个 optional peer
（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`），本来就靠宿主提供。

但对「别人装你的插件」这件事有意义：装的人如果 npm ≥ 12，任何需要 install 脚本的依赖都会静默不跑 ——
所以这个插件**继续保持零依赖**是对的。

---

## 发布前已经验过的（2026-10-21）

| 项目 | 结果 |
|---|---|
| `npm view dsh-icey` | 404 —— **名字没被占用**，可以发 |
| `npm pack --dry-run` | 21 个文件 / 60.2 kB，`probe/` 和 `shots/` 没被打进去 |
| 打包产物解压后跑 `selfcheck.mjs` | 47/47 通过 |
| 打包产物上跑 schema / client / apply 探针 | 全过 |
| 把 tgz 装进干净工程后 `import` | `dsh-icey`、`dsh-icey/agent`、`dsh-icey/client`、`dsh-icey/icon`、`locale/*.json` 全部能解析 |

也就是说「发出去的东西」和「本机能跑的东西」是同一份，没有漏文件。

---

## 1. 登录 npm（需要你自己做，一次性）

```bash
npm login
```

会开浏览器或要 OTP。开了两步验证的账号必须用 OTP 或 access token。

不想开浏览器就用 token：

```bash
npm config set //registry.npmjs.org/:_authToken=你的token
```

确认登录成功：

```bash
npm whoami
```

## 2. 发布

在 `D:\dsh\ICEY插件` 下：

```bash
npm publish
```

`package.json` 里已经写好 `publishConfig`（`access: public`、registry 指 npmjs），不用再加参数。

## 3. 立刻验证发出去的版本

```bash
npm view dsh-icey version dist.tarball
```

然后从 registry 真装一次（这一步才算发成功）：

```bash
# 在 DSH 的插件管理里，或者直接
dsh plugin install dsh-icey
```

在 **设置 → 插件** 里搜 `dsh-icey` 也能装到。

> 你现在这个 profile 装的是 `link:D:/dsh/ICEY插件`（本地链接）。要用 npm 版的话：
> 先在插件管理里把 dsh-icey 移除，再装 `dsh-icey@0.1.0`。
> 本地链接适合开发，npm 版适合给别人用。

## 4. 之后更新版本

```bash
npm version patch   # 0.1.0 -> 0.1.1（修 bug）
npm version minor   # 0.1.0 -> 0.2.0（加功能）
npm publish
```

---

## 发布前请自己过一眼

- **license / author**：现在是 `MIT` + `dsh-icey`。想挂自己名字就改 `author`。
- **repository**：没写。想让人看到源码就加上：
  ```json
  "repository": { "type": "git", "url": "git+https://github.com/你的名字/dsh-icey.git" },
  "homepage": "https://github.com/你的名字/dsh-icey#readme",
  "bugs": { "url": "https://github.com/你的名字/dsh-icey/issues" }
  ```
- **os: win32**：这个包只能在 Windows 上用（`user32` / `SendInput` / `PrintWindow`）。
  已经声明了 `os`，Linux/macOS 上装会直接拒绝而不是装完崩。
- **不含游戏资源**：仓库里只有代码，没有《艾希》的任何素材，别把游戏文件拷进来。

## 不发布 npm 的话

还有两条路，都不用登录 npm：

```bash
# 直接把 tgz 发给人，对方解压后装
npm pack

# 或者让人从 git 装
dsh plugin install github:你的名字/dsh-icey
```

---

## 常见坑

| 现象 | 原因 |
|---|---|
| `EPUBLISHCONFLICT` / `403` | 版本号已经存在。改版本号，**不要重发同一版** |
| `402 Payment Required` | 名字被当成私有包了。确认 `publishConfig.access = "public"` |
| 装上了但工具没出现 | 对方 DSH 版本低于 `engines.dsh`；或者没重启/没重载 |
| 面板不出来 | 客户端 bundle 要刷新页面（Ctrl+R） |
| `只能看不能动` | 对方 profile 里没有 `koffi`。`icey_status` 会写明，不是装错 |

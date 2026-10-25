# ICEY 插件 · 待办（2026-10-25 起）

写于 2026-10-24 23:30。今晚的结论和明天的活。

## 先决问题（这个不定，下面都白排）

**继续修感知层，还是换路？**

今晚验证清楚的是：这条路的问题不在"脑子不够聪明"，在"眼睛不准"。
GameScaling 0.8B 试过了，不可用（能看懂菜单和对话，但按键全错，0.8B 太小 + ICEY 不在语料里）。
照 [dsh-game](https://github.com/luckui/dsh-game) 那样给游戏塞 mod 也不行，ICEY 是 Unity 封闭程序。

所以要么在像素这条路继续往下修，要么承认它到顶了。

---

## A. 有数据支撑，直接能改

### A1. ✅ 已完成 — hudKick 从战斗判据里摘掉（2026-10-25）

**原计划「把阈值从 0.02 提到 0.06」是错的，已作废。**

错在哪：`hudKick = |HUD 区域平均亮度 - 上一帧| / 255`，是 0~1 的比例。
`FIGHT_HUDKICK = 0.02` 是 **2%**，不是 0.02%。而战斗帧里 hudKick 的中位数只有 **0.17%** ——
差 12 倍，真打起来永远够不着。

它真正会跳起来的场合是菜单开合、场景切换、过场。所以它不是「误报太多」，
是「**只在错的时候报**」—— 「第 1s 进入战斗（HUD 在跳）」那次的真相就是暂停菜单刚关上。

改法（`lib/autoplay.mjs`）：

```js
const fightingNow = activeRatio >= FIGHT_ACTIVE_RATIO
  || m.barrier === true
```

`hudKick` 彻底不参与战斗判断。常量留着，注释改成「留给识别 UI 大幅切换」，
并写明要用之前得先真机量一遍。

`selfcheck.mjs` 加了回归断言「HUD 大跳但画面静止 → 不判战斗（不空挥刀）」。
现在 **263 项全过**。

### A2. ✅ 已完成 — 删掉 `probe/battle-signal.mjs`

它的 `sample(dir, 60)` 从 593 张里抽 60 张，抽完相邻样本实际隔好几秒。
`motion` 量的是「两帧差多少」，所以抽稀让它的数值虚高约 50 倍（1.20% → 66.8%）。

昨晚就是被它误导，得出「战斗帧和旁观帧的 motion 分不开」这个错误结论。
留着会再骗一次，已删。替代品是 `probe/seq-signal.mjs`（逐帧、不抽稀）。

### A3. ✅ 保留两组负样本

`shots/combat2`（空地，40 帧）、`shots/combat3`（强化台旁，40 帧），都是 150ms 等间隔。
这是目前唯一干净的、非抽稀的负样本基线，以后改阈值要拿它们回归。

复算：`node probe/seq-signal.mjs shots/combat2 空地`

---

## B. 要先拿样本才能做

### B1. 真战斗的连续帧还缺

走两次都撞在强化台和铁栅栏上，一次真交火都没拍着。
需要：找到盾兵 / 无人机，交火时用 `node probe/burst.mjs 40 150 combatN` 连拍。

有了正样本才能定阈值，现在只有负样本。

### B2. 设施 vs 敌人

今晚把强化台当敌人劈了两刀，还拍了两轮"战斗帧"。根子在于 `analyzeFrame` 里完全没有"设施"这个概念。

设施：强化台、宝箱、门、拉杆、牌子
敌人：盾兵、四足、无人机

工具链现成（`probe/make-chest-template.mjs`、`make-arrow-template.mjs` 那套）。
难点是需要正面截图当模板，而且要考虑左右朝向。

### B3. 敌人外观要先认全
不确定 ICEY 一共有几种怪。需要用户说一声，或者翻视频抽帧统计。

---

## C. 知识层

### C1. ✅ 已完成 —— 结论：不要为这个写 skill provider

2026-10-25 实测：

1. 按 `dsh-video-pipeline` 的样子在插件根目录建了 `skills/icey-play/SKILL.md`（frontmatter 齐全）。
2. `skill({name:'icey-play'})` → `skill "icey-play" is unknown or no longer available`。
3. 查 host Service 目录（`cordis_inspect_query` → `Service.listService`）：**没有 skills 服务**。
4. 所以 DSH **不会自动扫描插件包里的 `skills/` 目录**。要让模型看见，得自己写 provider
   （`dsh-video-pipeline` 就带 `lib/provider.js` + `lib/frontmatter.js`）。

**改走的路**：`icey_playbook` 本来就是现成的规则卡入口，模型在工具列表里直接能看到。
把内容并进 `lib/playbook.mjs` 立刻可用，零 provider 工程。已做（commit `a01d953`）：

- `rules` 补两条：强化台是设施不是怪；暂停菜单 Enter 可能要按两次
- 新增 `combatDetection` 一节：旧 hudKick 判据为什么废、现在只认什么、要确认就 `icey_look`
- `digest` 补两条警告（每步都会看到的那份）

`skills/` 目录已删。

### C2. 什么时候才值得写 provider

当要发的 skill **多到 `icey_playbook` 装不下**，或者需要模型在**不玩游戏的时候**也看见它时。
单独一条规则卡不值得为它接一套 provider。

**另注**：`icey_playbook` 只对「模型做决定」的路径有用（`icey_act`）。
`icey_auto` / `icey_play` 是插件自己跑，**规则卡对它们一点用都没有**。

---

## D. 旧账（今晚之前就挂着的）

| # | 事项 | 状态 |
|---|---|---|
| D1 | `icey_auto` 的 advance 不推进（60 秒进 5 次战斗还在原地） | 根因已定位未修 |
| D2 | 战点推进规则（屏障消失 / 战斗结束 N 秒无新战斗 → 强制移动） | 提过，没建 |
| D3 | 低血量撤退（血从 10.6% 掉到 2.5%，自由玩时死过两次） | 没有 |
| D4 | 屏障阈值 85 / 1.6 从未在真机校准 | 估的 |
| D5 | 30 分钟引导整体测试 | 一直没做完 |

---

## E. 今晚新暴露的怪事

### E1. 菜单会自己打开
23:15:35 我只按了 `move:left:1300`（一个 A 键），游戏却进了暂停菜单。
不是按错键，也不是我按了 Esc。

这可能就是之前"游戏卡死"的真凶之一。要先搞清楚是游戏自身行为、还是插件抢前台造成的、还是按键序列串了。

### E2. 暂停菜单里 Enter 要按两次
第一次按 Enter 画面变了 14.46% 但菜单还在，第二次才恢复。

如果是真的，`safetyPaused` 那套自动恢复逻辑要跟着改。

---

## F. 清理

- `probe/_web/`：今晚下的三个 README（dsh-game、game-studios、awesome-plugins）+ GameScaling 那批已删。留着还是删。
- `probe/burst.mjs`、`probe/seq-signal.mjs`、`probe/contact.py`：新加的工具，建议留着（连拍和等间隔分析以后还要用）。
- 游戏现在停在铁栅栏前面（23:25 状态）。

---

## 建议的动手顺序

1. **A1**（10 分钟，纯改常量 + 跑 selfcheck，立刻见效）
2. **C1**（半小时，不依赖游戏）
3. **B1**（要游戏配合，找一场真交火）
4. **B2**（有了 B1 的样本才能做）
5. **E1**（观察，别急着改）
6. 剩下的 D 组按需要挑

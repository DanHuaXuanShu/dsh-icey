// 一次性：血量低时降低攻击欲望（不撤）。用完删。
import fs from "node:fs";
const p = "lib/autoplay.mjs";
let s = fs.readFileSync(p, "utf8");
let n = 0;
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log(`⚠️ 未命中：${tag}`); return }
  s = s.replace(a, b); n++; console.log(`✓ ${tag}`)
}

// 1. 加低血量权重表
rep(
  "  fight: { combo: 10, heavy: 6, attack: 5, chase: 1, dash: 1, storm: 0.4, shade: 0.3 },",
  `  fight: { combo: 10, heavy: 6, attack: 5, chase: 1, dash: 1, storm: 0.4, shade: 0.3 },

  // 血量/护盾明显掉了之后用的保守权重（2026-10-26 用户要求）。
  // 用户原话：「不要撤，血量低了，就把战斗时的攻击欲望降低」。
  // 所以这里**不加闪避、不加撤退**，只把出招比例压下来、把「等一等」拉高 ——
  // 打得谨慎些，但仗还是要打的。
  //
  // 对比 fight：
  //   攻击类（combo+heavy+attack） 从 89% 降到约 53%
  //   wait（原地等、观察）          从 0% 提到约 20%
  //   chase/dash（靠近/调整位置）   从 8% 提到约 26% —— 这是走位，不是逃跑
  fightLowHp: { combo: 4, heavy: 2, attack: 2, chase: 2, dash: 2, wait: 3, storm: 0.1, shade: 0.1 },`,
  "低血量权重表",
)

// 2. 删掉「先闪开」，换成标记低血量
rep(
  `        // 血量/护盾基线：用来判断「是不是在掉血」
        const hpNow = m.hudBright || 0
        if (hpNow > hpBaseline) hpBaseline = hpNow
        // 掉到基线的 72% 以下 ⇒ 正在挨打/护盾快破 ⇒ **先撤**，别硬吃（破盾后受击会倒地）
        if (hpBaseline > 0 && hpNow < hpBaseline * 0.72 && clock.now - lastDodgeAt > 1200) {
          lastDodgeAt = clock.now
          return {
            action: 'dash', dir: dir === 'right' ? 'left' : 'right', ms: 220,
            why: \`护盾/血量在掉（\${(hpNow * 100).toFixed(1)}% < 基线 \${(hpBaseline * 100).toFixed(1)}% 的 72%）→ 先闪开，避免破盾\`,
          }
        }`,
  `        // 血量/护盾基线：用来判断「血还够不够」
        //
        // ⚠️ 2026-10-26 改：原来这里是「掉到基线 72% 以下就先闪开」，用户否掉了 ——
        //    实测 120 秒里触发了 42 次 dash，几乎每三秒闪一次，等于放弃输出。
        //    而且「掉到基线 72%」不代表快死了，它只看相对变化，血量本来就低的时候会一直触发。
        //    用户要的是「不撤，降低攻击欲望」—— 所以改成：血量偏低时换一套保守权重表，
        //    出招比例从 89% 压到 53%，多等一等看清楚再打，但仗照打、不跑。
        const hpNow = m.hudBright || 0
        if (hpNow > hpBaseline) hpBaseline = hpNow
        const hpRatio = hpBaseline > 0 ? hpNow / hpBaseline : 1
        const lowHp = hpRatio < 0.55`,
  "血量逻辑改写",
)

// 3. 用对应的权重表
rep(
  `        // 打架时统一用「战斗权重」；抽到 combo 就按 COMBO_WEIGHTS 挑一套
        const pick = pickWeighted(ACTION_WEIGHTS.fight, rngSeed++)`,
  `        // 按血量选权重表：血够 → 正常进攻；血少 → 保守一点（少出招、多看两眼）
        const fightTable = lowHp ? ACTION_WEIGHTS.fightLowHp : ACTION_WEIGHTS.fight
        const pick = pickWeighted(fightTable, rngSeed++)`,
  "按血量选表",
)

// 4. wait 分支（保守表里会出现 wait）
rep(
  `        return { action: pick, ms: 130, why: '检测到连击数 → 按战斗权重出招' }`,
  `        // wait 只在保守表里出现：血量低的时候等一等，看清楚敌人的动作再出手
        if (pick === 'wait') {
          return { action: 'wait', ms: 260, why: \`血量偏低（\${Math.round(hpRatio * 100)}%）→ 缓一下，看清再说\` }
        }
        return {
          action: pick, ms: 130,
          why: lowHp
            ? \`血量偏低（\${Math.round(hpRatio * 100)}%）→ 保守出招\`
            : '检测到连击数 → 按战斗权重出招',
        }`,
  "wait 分支",
)

fs.writeFileSync(p, s, "utf8");
console.log(`\n共 ${n}/4 处`);

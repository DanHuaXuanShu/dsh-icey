/**
 * lib/store.mjs —— 配置持久化（插件自己的一份，不依赖 DSH 设置页）
 * ============================================================================
 * 🔴 为什么需要它：
 *   这台机器的 profile 树里**没有 `@deepseek-ai/schemastery`**，所以 index.js 的
 *   `Config` 是 undefined —— DSH 的「设置 → 插件 → 艾希」那一页就没有可编辑字段
 *   （cordis_inspect_query listConfigs 会显示 status: "absent"）。
 *   插件本身照常跑，但用户就**没地方改配置**了 —— 这不可接受。
 *
 * 所以配置分三层，优先级从高到低：
 *   1. DSH 设置页（volatile Cell，能用就用）
 *   2. 这个文件：`$DSH_HOME/icey/config.json`（面板和 /config PATCH 写它）
 *   3. lib/config.mjs 里的 DEFAULTS
 *
 * 写入用「写临时文件 + rename」—— 半截 JSON 会让下次启动读崩。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function homeDir() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'icey')
}

export function configPath() {
  return join(homeDir(), 'config.json')
}

/** 读持久化配置；文件不存在/坏了都返回 {}（绝不因为配置读不出来就让插件挂掉） */
export function loadOverrides() {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** 合并写：只覆盖传入的字段，其余保留 */
export function saveOverrides(patch = {}) {
  const file = configPath()
  const merged = { ...loadOverrides(), ...patch }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, path: file, config: merged }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), path: file }
  }
}

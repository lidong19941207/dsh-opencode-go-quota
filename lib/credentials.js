/**
 * 凭证解析。
 *
 * 各个额度源拿凭证的方式不一样：OpenCode 用模型设置里那把 key（DSH 凭证服务），
 * DeepSeek 又是模型设置里的另一把 key。
 * 适配器只声明「从哪取」，不自己碰 ctx——几种来源统一收敛在这里。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：插件装在 profile 目录下，那里解析不到内部包。
 * `ctx.credentials.resolve()` 在运行时只是普通方法调用。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CredentialError } from './errors.js'

/** 把开头的 `~` 换成家目录——配置里写 `~/.x/config.json` 比写绝对路径可移植。 */
function expandHome(file) {
  if (file === '~') return homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return join(homedir(), file.slice(2))
  return file
}

/**
 * 按点路径取 JSON 里的值，例如 `profiles.default.controlKey`。
 * @param file - 已展开家目录的文件路径。
 * @param dotted - 点分隔的键路径；留空表示整个文件就是那个值。
 * @returns 找到的字符串，找不到或解析失败返回 undefined。
 */
function readJsonPath(file, dotted) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (!dotted) return typeof parsed === 'string' ? parsed : undefined
  let node = parsed
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = node[part]
  }
  return typeof node === 'string' && node.length > 0 ? node : undefined
}

/**
 * 解析一份凭证规格。
 *
 * 规格形态（适配器通过 `credential(cfg)` 给出）：
 *   { from: 'dsh',  ref }            DSH 凭证服务，也就是模型设置里配的那把 key
 *   { from: 'env',  name }           进程环境变量
 *   { from: 'file', path, key }      本地 JSON 文件里的点路径
 *
 * @param spec - 凭证规格；空值表示「这个 provider 不需要凭证」。
 * @param ctx - Cordis 上下文，只有 dsh 来源会用到。
 * @returns 凭证字符串；取不到时返回 undefined。
 */
export async function resolveCredential(spec, ctx) {
  if (!spec) return undefined

  if (spec.from === 'dsh') {
    if (!ctx || !ctx.credentials) throw new CredentialError('凭证服务不可用')
    let hit
    try {
      hit = await ctx.credentials.resolve(spec.ref)
    } catch (error) {
      throw new CredentialError('读取凭证失败：' + String((error && error.message) || error))
    }
    return hit && hit.value ? hit.value : undefined
  }

  if (spec.from === 'env') {
    const value = process.env[spec.name]
    return value && value.length > 0 ? value : undefined
  }

  if (spec.from === 'file') {
    if (!spec.path) throw new CredentialError('file 凭证缺少 path')
    return readJsonPath(expandHome(spec.path), spec.key)
  }

  throw new CredentialError('未知的凭证来源：' + String(spec.from))
}

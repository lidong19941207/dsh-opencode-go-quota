/**
 * provider 注册表。
 *
 * 加一家新的额度源 = 在这里加一行 import。
 * 客户端不需要改：它按 Host 下发的 `windows` / `balance` 渲染，窗口名走字典、
 * 字典没有就用适配器给的 `fallbackLabel`。
 */
import * as deepseek from './deepseek.js'
import * as opencodeGo from './opencode-go.js'

/** 注册顺序即侧边栏徽标里的行顺序。 */
export const PROVIDERS = [opencodeGo, deepseek]

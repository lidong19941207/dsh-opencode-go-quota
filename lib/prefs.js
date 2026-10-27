/**
 * 记住「用户翻到哪一家」。
 *
 * 为什么不在浏览器里存 localStorage：
 * **GUI 端口每次重启都会变**（实测 60043 → 60877 → 62355 → 64393），
 * 而 localStorage 按 origin 隔离（协议 + 主机 + 端口），端口一变就是另一个 origin，
 * 之前存的全都读不到。所以「关闭 DSH 再打开，回到第一张卡」这个现象里，
 * 浏览器存储根本救不了，必须落在 Host 侧的磁盘上。
 *
 * 存在哪：DSH 的 harness home（`~/.dsh`）下的插件私有文件，不碰用户自己的配置。
 * 用 `$DSH_HOME` 优先，没设就退回 `~/.dsh`，这样测试也能用临时目录。
 *
 * 写盘策略：只在值真的变了才写，且失败不抛——记住选择是锦上添花，
 * 不能因为它把整个轮询搞挂。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

/** 插件私有的偏好文件，放在 harness home 下。 */
function prefsFile() {
  const home = process.env.DSH_HOME || process.env.DSH_HARNESS_HOME || join(homedir(), '.dsh')
  return join(home, 'opencode-go-quota.json')
}

/** 进程内缓存：每次 `/state` 都读盘没必要。 */
let cache
/** 串行化写入，避免两次快速翻页产生交错的写。 */
let pending = Promise.resolve()

/**
 * 读回上次选中的 provider id。
 * @returns 形如 `'deepseek'`；没记录过、或文件坏了，都返回 null。
 */
export async function readSelected() {
  if (cache !== undefined) return cache
  try {
    const raw = await readFile(prefsFile(), 'utf8')
    const parsed = JSON.parse(raw)
    // 只接受字符串：文件可能被人手改坏，或被别的版本写过别的结构。
    cache = typeof parsed?.selectedProvider === 'string' ? parsed.selectedProvider : null
  } catch {
    // 文件不存在是最常见的情况（第一次用），不是错误。
    cache = null
  }
  return cache
}

/**
 * 记住选中项。
 * @param id - provider id；传 null 表示清空（回落到第一家）。
 * @returns 写入完成后 resolve；写失败也不 reject。
 */
export function writeSelected(id) {
  const next = typeof id === 'string' && id.length > 0 ? id : null
  // 值没变就不写盘：翻来翻去、以及每次开关卡片都会触发写入。
  if (cache === next) return pending
  cache = next
  pending = pending
    .then(async () => {
      const file = prefsFile()
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, JSON.stringify({ selectedProvider: next }, null, 2) + '\n', 'utf8')
    })
    .catch(() => {
      // 落盘失败（只读文件系统、磁盘满……）不该影响功能：本次会话内 cache 仍然有效。
    })
  return pending
}

/** 仅供测试：清掉进程内缓存，强制下次重新读盘。 */
export function resetCacheForTests() {
  cache = undefined
  pending = Promise.resolve()
}

export { prefsFile }

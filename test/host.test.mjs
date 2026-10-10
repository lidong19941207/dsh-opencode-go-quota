/**
 * Host 半边的离线逻辑测试。
 *
 * 做法：伪造一个最小 Cordis 上下文把 apply() 跑起来，再通过插件**自己注册的路由**
 * 读回快照——测的是真实代码路径，不是复制一份逻辑出来测。
 *
 * 重点回归：**失败不能抹掉已经拿到的数据**。改之前失败分支会把 usage 置 null 并把
 * fetchedAt 重置成失败时刻，一次上游抖动就让界面从「45%」变成「—」，而且状态行会
 * 谎称「刚刚刷新」。
 *
 * 凭证按以下顺序取，两处都没有则只跑不联网的用例：
 *   1. 环境变量 OPENCODE_GO_API_KEY
 *   2. ~/.dsh/.credentials.yaml 里的 OPENCODE_GO_API_KEY
 *
 * 运行：node test/host.test.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Windows 上 URL.pathname 会带前导斜杠并把盘符弄坏，直接用 href 让 Node 自己解析。
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * 解析凭证：环境变量优先，其次 DSH 的凭证文件。
 * @returns 真实 key，或 undefined。
 */
function resolveKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return /^\s{2}OPENCODE_GO_API_KEY:\s*(\S+)\s*$/m.exec(yaml)?.[1]
  } catch {
    return undefined
  }
}

const KEY = resolveKey()

/**
 * 记录 Host 侧排的定时器间隔，用来验证退避策略。
 *
 * 必须在 sleep 定义之前抓住真的 setTimeout：undici 自己也会排连接超时，
 * 所以只按「出现过哪些间隔」断言，不依赖先后顺序。
 */
const timerDelays = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...rest) => {
  timerDelays.push(ms)
  return realSetTimeout(fn, ms, ...rest)
}
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

const checks = []
const check = (label, ok, detail) => {
  checks.push(ok)
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '  ' + detail))
}

/**
 * 造最小 ctx。只提供 apply() 用到的四样东西。
 * @param resolve - 可替换的凭证解析函数，用来模拟凭证故障。
 */
function makeCtx(resolve) {
  const box = { route: null }
  return {
    box,
    ctx: {
      credentials: { resolve: resolve || (async () => ({ value: KEY })) },
      effect: (fn) => fn(),
      connection: { admit: () => ({}) },
      webServer: {
        register: (route) => {
          box.route = route
          return () => {}
        },
      },
    },
  }
}

/** 走插件自己的路由读快照；force=true 则带 refresh=1 触发一次上游拉取。 */
async function readState(box, force) {
  let body = null
  const req = { url: '/opencode-go-quota/state' + (force ? '?refresh=1' : '') }
  const res = { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } }
  await box.route.handler(req, res)
  return body
}

if (!KEY) {
  console.log('未找到 OPENCODE_GO_API_KEY（环境变量与 ~/.dsh/.credentials.yaml 都没有），跳过联网用例。\n')
}

// ---- A 上游不可达（不需要真实凭证，key 用假的） ------------------------------
console.log('A 上游不可达（全新实例，没有旧数据）')
{
  const mark = timerDelays.length
  const { ctx, box } = makeCtx(async () => ({ value: 'sk-not-a-real-key' }))
  apply(ctx, { baseUrl: 'https://127.0.0.1:1', pollIntervalSec: 300, maxBackoffSec: 1800 })
  await sleep(3000)
  const s = await readState(box, false)
  check('ok === false', s.ok === false)
  check('state === network', s.state === 'network', s.state)
  check('没有旧数据时 usage 为 null', s.usage === null)
  check('没有旧数据时 stale 为 false', s.stale === false)
  check('lastAttemptAt 被记录', typeof s.lastAttemptAt === 'number')

  // 关键回归：一条数据都没有时，指数退避会把下一次重试推到 10 分钟，
  // 用户对着「—」干等。暂时性失败必须被压到 60 秒。
  const scheduled = timerDelays.slice(mark)
  check('**无数据 + 暂时性失败：排了 60 秒的重试**', scheduled.includes(60_000), scheduled.join(', '))
  check('**没有被指数退避推到 600 秒**', !scheduled.includes(600_000), scheduled.join(', '))
}

// ---- D 无数据 + 确定性失败：不享受提速（不需要网络） -------------------------
console.log('\nD 无数据 + 确定性失败（凭证缺失）')
{
  const mark = timerDelays.length
  const { ctx, box } = makeCtx(async () => undefined)
  apply(ctx, { baseUrl: 'https://127.0.0.1:1', pollIntervalSec: 300, maxBackoffSec: 1800 })
  await sleep(1500)
  const s = await readState(box, false)
  check('state === no-key', s.state === 'no-key', s.state)
  const scheduled = timerDelays.slice(mark)
  // 凭证没配不会自己好，提速只是空转；仍按 2 的幂退避（300s × 2^1）。
  check('**凭证缺失时不做 60 秒提速**', !scheduled.includes(60_000), scheduled.join(', '))
  check('**凭证缺失时按指数退避（600 秒）**', scheduled.includes(600_000), scheduled.join(', '))
}

if (KEY) {
  // ---- B 正常路径 -----------------------------------------------------------
  console.log('\nB 正常路径')
  {
    const mark = timerDelays.length
    const { ctx, box } = makeCtx()
    apply(ctx, { baseUrl: 'https://opencode.ai', pollIntervalSec: 300 })
    await sleep(4000)
    const s = await readState(box, false)
    console.log(
      '    rolling=%s%% weekly=%s%% monthly=%s%%',
      s.usage?.rolling?.percent,
      s.usage?.weekly?.percent,
      s.usage?.monthly?.percent,
    )
    check('ok === true', s.ok === true)
    check('state === ok', s.state === 'ok', s.state)
    check('三个窗口齐全', !!(s.usage?.rolling && s.usage?.weekly && s.usage?.monthly))
    check('stale === false', s.stale === false)
    check('阈值随快照下发', s.thresholds?.warn === 80 && s.thresholds?.critical === 95)
    // 拿到数据后不该再提速：按配置的 300 秒走。
    const scheduled = timerDelays.slice(mark)
    check('有数据时按配置节奏（300 秒）', scheduled.includes(300_000), scheduled.join(', '))
    check('有数据时不出现 60 秒提速', !scheduled.includes(60_000), scheduled.join(', '))
  }

  // ---- C 先成功后失败：关键回归 ---------------------------------------------
  console.log('\nC 同一实例：先成功后失败')
  {
    let broken = false
    const { ctx, box } = makeCtx(async () => {
      if (broken) throw new Error('模拟凭证服务故障')
      return { value: KEY }
    })
    apply(ctx, { baseUrl: 'https://opencode.ai', pollIntervalSec: 300 })

    await sleep(4000)
    const good = await readState(box, false)
    console.log('    成功: ok=%s monthly=%s%% fetchedAt=%s', good.ok, good.usage?.monthly?.percent, good.fetchedAt)

    broken = true
    const failed = await readState(box, true) // 手动刷新触发一次会失败的上游拉取
    console.log('    失败: ok=%s state=%s stale=%s', failed.ok, failed.state, failed.stale)

    check('失败时 ok === false', failed.ok === false)
    check('失败时 state === no-key', failed.state === 'no-key', failed.state)
    check('**旧 usage 被保留**', failed.usage !== null && failed.usage.monthly.percent === good.usage.monthly.percent)
    check('**fetchedAt 未被失败时刻覆盖**', failed.fetchedAt === good.fetchedAt, String(failed.fetchedAt))
    check('**stale === true**', failed.stale === true)
    check('lastAttemptAt 已推进', failed.lastAttemptAt > good.lastAttemptAt)
  }
}

const failed = checks.filter((ok) => !ok).length
console.log('\n' + (failed === 0 ? '全部通过（' + checks.length + ' 项）' : failed + ' / ' + checks.length + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)

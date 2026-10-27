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
 *
 * 插件会注册**两条**路由（/state 与 /select），所以这里按 path 分桶存，
 * 不能用单个 `box.route`——后注册的会把前一条覆盖掉。
 * @param resolve - 可替换的凭证解析函数，用来模拟凭证故障。
 */
function makeCtx(resolve) {
  const box = { routes: new Map(), get route() { return this.routes.get('/opencode-go-quota/state') || null } }
  return {
    box,
    ctx: {
      credentials: { resolve: resolve || (async () => ({ value: KEY })) },
      effect: (fn) => fn(),
      connection: { admit: () => ({}) },
      webServer: {
        register: (route) => {
          box.routes.set(route.path, route)
          return () => {}
        },
      },
    },
  }
}

/**
 * 只开 OpenCode Go 的配置。
 *
 * A/B/C/D 四节测的是它的退避节奏，多一家会往同一个 setTimeout 序列里掺进别人的
 * 定时器，断言就不可读了。多 provider 的隔离单独放在 F 节测，所以这里把另外两家
 * 都显式关掉。
 * @param overrides - opencode-go 自己的配置覆盖。
 */
function onlyOpenCode(overrides) {
  return {
    pollIntervalSec: 300,
    maxBackoffSec: 1800,
    providers: { 'opencode-go': overrides, deepseek: { enabled: false } },
  }
}

/** 走插件自己的路由读整份快照；force=true 则带 refresh=1 触发一次上游拉取。 */
async function readState(box, force) {
  let body = null
  const req = { url: '/opencode-go-quota/state' + (force ? '?refresh=1' : '') }
  const res = { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } }
  await box.route.handler(req, res)
  return body
}

/** 只读某一家 provider。 */
function pick(body, id) {
  return (body.providers || []).find((provider) => provider.id === id) || null
}

if (!KEY) {
  console.log('未找到 OPENCODE_GO_API_KEY（环境变量与 ~/.dsh/.credentials.yaml 都没有），跳过联网用例。\n')
}

// ---- A 上游不可达（不需要真实凭证，key 用假的） ------------------------------
console.log('A 上游不可达（全新实例，没有旧数据）')
{
  const mark = timerDelays.length
  const { ctx, box } = makeCtx(async () => ({ value: 'sk-not-a-real-key' }))
  apply(ctx, onlyOpenCode({ baseUrl: 'https://127.0.0.1:1' }))
  await sleep(3000)
  const body = await readState(box, false)
  const s = pick(body, 'opencode-go')
  check('快照里带着注册的 provider', body.providers.length === 1 && !!s)
  check('provider 自带品牌与凭证标签', s.name === 'OpenCode Go' && s.mark === 'Go' && s.credentialLabel === 'OPENCODE_GO_API_KEY')
  check('ok === false', s.ok === false)
  check('state === network', s.state === 'network', s.state)
  check('没有旧数据时 windows 为 null', s.windows === null)
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
  apply(ctx, onlyOpenCode({ baseUrl: 'https://127.0.0.1:1' }))
  await sleep(1500)
  const s = pick(await readState(box, false), 'opencode-go')
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
    apply(ctx, onlyOpenCode({ baseUrl: 'https://opencode.ai' }))
    await sleep(4000)
    const body = await readState(box, false)
    const s = pick(body, 'opencode-go')
    console.log(
      '    rolling=%s%% weekly=%s%% monthly=%s%%',
      s.windows?.[0]?.percent,
      s.windows?.[1]?.percent,
      s.windows?.[2]?.percent,
    )
    if (s.state === 'no-subscription') {
      // 这把 key 没有 Go 订阅（上游 403 EntitlementError）。这是**账号状态**而不是
      // 代码故障，所以不该让整套测试变红：改成断言「403 被正确归一成 no-subscription」。
      // 想看窗口数据请换一把有订阅的 key，或跑 G 节的假数据用例。
      console.log('    （当前 key 无 OpenCode Go 订阅，跳过窗口断言）')
      check('403 归一成 no-subscription', s.state === 'no-subscription', s.state)
      check('无订阅时不伪造窗口数据', s.windows === null || s.windows.length === 0)
    } else {
      check('ok === true', s.ok === true)
      check('state === ok', s.state === 'ok', s.state)
      check('三个窗口齐全且顺序稳定', Array.isArray(s.windows) && s.windows.length === 3 && s.windows[2].key === 'monthly')
      check('窗口带重置时刻', typeof s.windows?.[0]?.resetsAt === 'string')
    }
    check('stale === false', s.stale === false)
    check('阈值随快照下发', body.thresholds?.warn === 80 && body.thresholds?.critical === 95)
    // 拿到数据后不该再提速：按配置的 300 秒走。无订阅时手上一个数字都没有，
    // 走的是确定性失败的退避（600 秒），这条断言不适用。
    const scheduled = timerDelays.slice(mark)
    if (s.ok === true) {
      check('有数据时按配置节奏（300 秒）', scheduled.includes(300_000), scheduled.join(', '))
      check('有数据时不出现 60 秒提速', !scheduled.includes(60_000), scheduled.join(', '))
    } else {
      console.log('    （无数据，节奏断言见 D 节的确定性失败用例）')
      check('无数据时不排 60 秒提速', !scheduled.includes(60_000), scheduled.join(', '))
    }
  }

  // ---- C 先成功后失败：关键回归 ---------------------------------------------
  console.log('\nC 同一实例：先成功后失败')
  {
    let broken = false
    const { ctx, box } = makeCtx(async () => {
      if (broken) throw new Error('模拟凭证服务故障')
      return { value: KEY }
    })
    apply(ctx, onlyOpenCode({ baseUrl: 'https://opencode.ai' }))

    await sleep(4000)
    const good = pick(await readState(box, false), 'opencode-go')
    console.log('    成功: ok=%s monthly=%s%% fetchedAt=%s', good.ok, good.windows?.[2]?.percent, good.fetchedAt)

    broken = true
    const failed = pick(await readState(box, true), 'opencode-go') // 手动刷新触发一次会失败的上游拉取
    console.log('    失败: ok=%s state=%s stale=%s', failed.ok, failed.state, failed.stale)

    check('失败时 ok === false', failed.ok === false)
    check('失败时 state === no-key', failed.state === 'no-key', failed.state)
    // 「失败不抹掉已拿到的数据」只有在第一次真的拿到过数据时才有东西可验。
    // 无订阅时首次就是空的，这两项没有可保留的对象。
    if (good.fetchedAt !== null) {
      check('**旧 windows 被保留**', failed.windows !== null && failed.windows[2].percent === good.windows[2].percent)
      check('**fetchedAt 未被失败时刻覆盖**', failed.fetchedAt === good.fetchedAt, String(failed.fetchedAt))
      check('**stale === true**', failed.stale === true)
    } else {
      console.log('    （首次未拿到数据，跳过「保留旧数据」两项）')
      check('**没有旧数据时 stale 保持 false**', failed.stale === false)
    }
    check('lastAttemptAt 已推进', failed.lastAttemptAt > good.lastAttemptAt)
  }
}

// ---- E DeepSeek 余额适配器：纯映射，不联网 ----------------------------------
console.log('\nE DeepSeek 余额适配器（假的 fetch）')
{
  const deepseek = await import(new URL('../lib/providers/deepseek.js', import.meta.url).href)
  const cfg = deepseek.defaults

  /** 用固定响应造一个假 fetch。 */
  const stub = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })

  const ok = await deepseek.poll({
    cfg,
    key: 'k',
    fetchImpl: stub(200, {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    }),
  })
  check('没有窗口（余额型）', Array.isArray(ok.windows) && ok.windows.length === 0)
  check('余额归一成 money 项', ok.balance.length === 1 && ok.balance[0].kind === 'money' && ok.balance[0].amount === '110.00' && ok.balance[0].currency === 'CNY')

  const both = await deepseek.poll({
    cfg,
    key: 'k',
    fetchImpl: stub(200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '700.00' },
        { currency: 'USD', total_balance: '100.00' },
      ],
    }),
  })
  check('两档货币时优先美元', both.balance[0].currency === 'USD' && both.balance[0].amount === '100.00')

  const poor = await deepseek.poll({
    cfg,
    key: 'k',
    fetchImpl: stub(200, { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }),
  })
  check('余额耗尽时状态为 no-balance 但仍带数据', poor.state === 'no-balance' && poor.balance[0].amount === '0.00')

  let badKey = null
  try {
    await deepseek.poll({ cfg, key: 'k', fetchImpl: stub(401, {}) })
  } catch (error) {
    badKey = error
  }
  check('401 归一成 bad-key', badKey && badKey.state === 'bad-key', badKey && badKey.state)

  let emptyBody = null
  try {
    await deepseek.poll({ cfg, key: 'k', fetchImpl: stub(200, { balance_infos: [] }) })
  } catch (error) {
    emptyBody = error
  }
  check('balance_infos 为空归一成 bad-payload', emptyBody && emptyBody.state === 'bad-payload', emptyBody && emptyBody.state)
}

// ---- F 多 provider：各管各的 ------------------------------------------------
console.log('\nF 两个 provider 各管各的')
{
  // 只给 OpenCode 发凭证；DeepSeek 故意让它缺失，验证一家缺凭证不影响另一家。
  const { ctx, box } = makeCtx(async (ref) => (ref === 'DEEPSEEK_API_KEY' ? undefined : { value: 'sk-fake' }))
  apply(ctx, {
    pollIntervalSec: 300,
    maxBackoffSec: 1800,
    providers: { 'opencode-go': { baseUrl: 'https://127.0.0.1:1' }, deepseek: {} },
  })
  await sleep(2000)
  const body = await readState(box, false)
  const oc = pick(body, 'opencode-go')
  const ds = pick(body, 'deepseek')
  check('快照里两家都在', body.providers.length === 2 && !!oc && !!ds)
  check('OpenCode 是网络失败', oc.state === 'network', oc.state)
  check('DeepSeek 是缺凭证', ds.state === 'no-key', ds.state)
  check('两家的品牌标识不同', oc.mark === 'Go' && ds.mark === 'DS')
  check('DeepSeek 没有窗口数据', ds.windows === null || ds.windows.length === 0, JSON.stringify(ds.windows))
  check('两家各自记录尝试时间', typeof oc.lastAttemptAt === 'number' && typeof ds.lastAttemptAt === 'number')
}

// ---- H 记住翻到哪一家 -------------------------------------------------------
//
// 回归的是这条用户反馈：「关闭 dsh 又重启后，显示的是第一张卡片，没有记忆之前选择」。
//
// 为什么不能靠 localStorage：GUI 端口每次重启都会变（实测 60043 → 60877 → 62355
// → 64393），而 localStorage 按 origin（协议+主机+端口）隔离，端口一变就是另一个
// origin，之前存的读不到。所以必须落在 Host 侧磁盘上。
console.log('\nH 记住翻到哪一家')
{
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'quota-prefs-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const prefs = await import('../lib/prefs.js')

  try {
    // 新装/首次运行：没有文件，读到 null，且不能抛。
    prefs.resetCacheForTests()
    check('首次没有记录时读到 null', (await prefs.readSelected()) === null)

    // 写入后再读回。
    await prefs.writeSelected('deepseek')
    prefs.resetCacheForTests() // 清掉进程内缓存，逼它真读盘
    check('写盘后能读回选中项', (await prefs.readSelected()) === 'deepseek', await prefs.readSelected())

    // 这才是「重启」的等价场景：新进程没有内存缓存，只能靠磁盘。
    const raw = await readFile(prefs.prefsFile(), 'utf8')
    check('落盘内容可被解析', JSON.parse(raw).selectedProvider === 'deepseek', raw.trim())

    // 传 null 表示清空。
    await prefs.writeSelected(null)
    prefs.resetCacheForTests()
    check('null 清除选择', (await prefs.readSelected()) === null)

    // 文件被手工写坏：不能抛，退化成 null。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(prefs.prefsFile(), '{ this is not json', 'utf8')
    prefs.resetCacheForTests()
    check('文件损坏时退化为 null 而不抛', (await prefs.readSelected()) === null)

    // ---- 路由层：/state 下发 selectedId，/select 写入 ----
    prefs.resetCacheForTests()
    const { ctx, box } = makeCtx()
    // 这条用例要验证「已知 provider 能存」，所以不能只开一家——
    // 用 onlyOpenCode 的话 deepseek 是被 disabled 的，写它会被正确地拒成 422。
    const app = await import('../lib/index.js')
    app.apply(ctx, { pollIntervalSec: 300, maxBackoffSec: 1800 })

    const state = box.routes.get('/opencode-go-quota/state')
    const select = box.routes.get('/opencode-go-quota/select')
    check('/state 与 /select 各注册了一条路由', Boolean(state) && Boolean(select))

    /** 走 select 路由发一次 POST。 */
    const postSelect = async (payload, method) => {
      let status = null
      let text = ''
      const req = {
        method: method || 'POST',
        async *[Symbol.asyncIterator]() {
          if (payload !== undefined) yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
        },
      }
      const res = { writeHead: (code) => { status = code }, end: (t) => { text = t || '' } }
      await select.handler(req, res)
      return { status, text }
    }

    const okPost = await postSelect({ selectedId: 'deepseek' })
    check('/select 接受已知 provider', okPost.status === 204, String(okPost.status))

    // /state 应把选择一起下发，客户端才能据此开页。
    let stateBody = null
    await state.handler({ url: '/opencode-go-quota/state' }, { writeHead: () => {}, end: (t) => { stateBody = JSON.parse(t) } })
    check('/state 下发 selectedId', stateBody.selectedId === 'deepseek', String(stateBody.selectedId))

    // 不存在的 provider 必须拒绝：否则记下已删除的 id，下次启动找不到页。
    const badPost = await postSelect({ selectedId: 'no-such-provider' })
    check('/select 拒绝未知 provider', badPost.status === 422, String(badPost.status))

    // 只允许 POST。
    const getSelect = await postSelect(undefined, 'GET')
    check('/select 拒绝 GET', getSelect.status === 405, String(getSelect.status))

    // 坏 JSON 不能崩，也不能把已有选择冲掉。
    const badJson = await postSelect('{oops')
    check('/select 坏 JSON 返回 400', badJson.status === 400, String(badJson.status))
    prefs.resetCacheForTests()
    check('坏请求不影响已存的选择', (await prefs.readSelected()) === 'deepseek', String(await prefs.readSelected()))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(dir, { recursive: true, force: true })
  }
}

const failed = checks.filter((ok) => !ok).length
console.log('\n' + (failed === 0 ? '全部通过（' + checks.length + ' 项）' : failed + ' / ' + checks.length + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)

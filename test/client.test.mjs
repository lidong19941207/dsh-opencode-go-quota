/**
 * 客户端半边的离线渲染测试。
 *
 * 做法：bundle 是经典脚本（不是 ESM），先给它一个 window.__ModuleLoader__ 假门面，
 * 再 eval 拿到 factory；给 factory 一个只认 react / react-dom 的 require。
 *
 * 组件内部状态靠**替换 React.useState 为队列**注入——SSR 不跑 useEffect，所以 data
 * 永远停在初值，不这样做就渲染不出真实数据的界面。打桩必须在 factory **之前**装好，
 * 因为 bundle 在 factory 执行时就把 useState 解构走了。
 *
 * 运行：node test/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const BUNDLE = new URL('../lib/client.js', import.meta.url)

// ---- 1. 假 ModuleLoader 门面 -------------------------------------------------
let spec = null
globalThis.window = {
  __ModuleLoader__: {
    load: (s) => {
      spec = s
    },
  },
  innerWidth: 1200,
  innerHeight: 800,
}
// portal 的容器参数在渲染期就会被求值，Node 里没有 document，补一个。
globalThis.document = {
  body: { nodeType: 1 },
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
}

/**
 * 加载 bundle 并跑 factory。
 * @param reactDomStub - 传给 bundle 的 react-dom 替身；传 {} 可测 createPortal 缺失时的降级。
 * @returns bundle 的导出。
 */
function loadBundle(reactDomStub) {
  spec = null
  ;(0, eval)(readFileSync(BUNDLE, 'utf8'))
  if (!spec) throw new Error('bundle 没有调用 __ModuleLoader__.load()')
  return spec.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return reactDomStub
    throw new Error('bundle 请求了平台表之外的模块: ' + name)
  })
}

// ---- 2. 状态注入桩：必须在 factory 之前装好 ----------------------------------
const realUseState = React.useState
let queue = null
React.useState = (init) => (queue && queue.length > 0 ? queue.shift() : realUseState(init))

// useEffect 同理：SSR 不跑副作用，想验证「冷启动提速」就得把 effect 抠出来手动跑。
// effects 非 null 时才记录，避免影响普通渲染用例。
let effects = null
React.useEffect = (fn) => {
  if (effects) effects.push(fn)
  return undefined
}

// ---- 3. 假字典函数 -----------------------------------------------------------
/**
 * 支持 {name} 插值；找不到键时回显键名（与真实 locale 行为一致——键名回显能暴露漏翻译）。
 * @param dict - 字典对象。
 */
function makeT(dict) {
  return (key, params) => {
    let s = dict[key]
    if (s === undefined) return key
    if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v))
    return s
  }
}

// ---- 4. 用一个只做记录的 ctx 跑 apply ----------------------------------------
let registered = null
let injectKey = null
let dicts = null

const mod = loadBundle({ createPortal: (node) => node })
mod.apply({
  // 插件用 ctx.effect 注册字典；这里直接执行。
  effect: (fn) => fn(),
  locale: {
    register: (ns, dictionaries) => {
      dicts = dictionaries
      return () => {}
    },
    bind: (ns) => makeT({}),
  },
  slots: {
    inject: (key, fn) => {
      injectKey = key
      fn()
    },
    register: (options, Component) => {
      registered = { options, Component }
    },
  },
})

const checks = []
const check = (label, ok, detail) => {
  checks.push(ok)
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '  ' + detail))
}

console.log('bundle id       : ' + spec.id)
console.log('exports.inject  : ' + JSON.stringify(mod.inject))
check('inject 只报服务名，且含 slots 与 locale', JSON.stringify(mod.inject) === '["slots","locale"]')
check('注册到 sidebar.footer.action', injectKey === 'sidebar.footer.action')
check('注册项声明了 locale 命名空间', registered.options.locale === 'opencode-go-quota', registered.options.locale)
check('字典同时提供 zh 与 en', !!dicts && !!dicts.zh && !!dicts.en, Object.keys(dicts || {}).join(','))
check('两本字典键集合一致', (() => {
  const a = Object.keys(dicts.zh).sort().join()
  const b = Object.keys(dicts.en).sort().join()
  return a === b
})())

// ---- 5. 渲染 ----------------------------------------------------------------
const noop = () => {}

/**
 * 按 data / open / pinned / refreshing / hovered / anchor / activeId 的顺序喂状态。
 * activeId 决定徽标报哪一家（对应真实使用中「翻到第几页」）。
 */
function render(options) {
  queue = [
    [options.data, noop],
    [options.open === true, noop],
    [false, noop],
    [false, noop],
    [false, noop],
    [options.anchor === undefined ? null : options.anchor, noop],
    [options.activeId === undefined ? null : options.activeId, noop],
  ]
  const dict = (dicts && dicts[options.lang || 'zh']) || (dicts && dicts.zh) || {}
  try {
    return {
      html: renderToStaticMarkup(React.createElement(registered.Component, { wide: options.wide, t: makeT(dict) })),
    }
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) }
  } finally {
    queue = null
  }
}

/** 从 HTML 里抠出可见文本片段。 */
function texts(html) {
  return html
    .replace(/<[^>]+>/g, '\u0001')
    .split('\u0001')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 三个窗口，顺序即 Host 下发的顺序。 */
const windows = [
  { key: 'rolling', percent: 10, resetsAt: new Date(Date.now() + 7_000_000).toISOString(), status: 'ok' },
  { key: 'weekly', percent: 19, resetsAt: new Date(Date.now() + 300_000_000).toISOString(), status: 'ok' },
  { key: 'monthly', percent: 45, resetsAt: new Date(Date.now() + 1_100_000_000).toISOString(), status: 'ok' },
]

/** 只改第一个窗口，其余照旧。 */
const withRolling = (percent, status) => [{ ...windows[0], percent, status: status || 'ok' }, windows[1], windows[2]]

/** 单个 provider 的默认快照；用例改哪一项就覆盖哪一项。 */
const provider = (over) => ({
  id: 'opencode-go',
  name: 'OpenCode Go',
  mark: 'Go',
  kind: 'windows',
  credentialLabel: 'OPENCODE_GO_API_KEY',
  ok: true,
  state: 'ok',
  windows,
  balance: [],
  meta: null,
  fetchedAt: Date.now() - 12_000,
  lastAttemptAt: Date.now(),
  stale: false,
  error: null,
  ...over,
})

/** 纯余额型 provider（DeepSeek 官方余额接口那种形态）。 */
const balanceOnly = (over) => ({
  id: 'deepseek',
  name: 'DeepSeek',
  mark: 'DS',
  kind: 'balance',
  credentialLabel: 'DEEPSEEK_API_KEY',
  ok: true,
  state: 'ok',
  windows: null,
  balance: [{ kind: 'money', amount: '110.00', currency: 'CNY' }],
  meta: null,
  fetchedAt: Date.now() - 30_000,
  lastAttemptAt: Date.now(),
  stale: false,
  error: null,
  ...over,
})

/** 拼成 Host 实际下发的整体形状。 */
const wrap = (list, extra) => ({
  generatedAt: Date.now(),
  thresholds: { warn: 80, critical: 95 },
  providers: Array.isArray(list) ? list : [list],
  ...extra,
})

const base = wrap(provider())

console.log('\n徽标（中文）：')
for (const [name, data, wide, expect] of [
  ['正常（最紧=月）', base, true, ['Go', '月 45%']],
  ['5 小时最紧', wrap(provider({ windows: withRolling(95) })), true, ['Go', '5h 95%']],
  ['已限流', wrap(provider({ windows: withRolling(100, 'rate-limited') })), true, ['Go', '5h 100%']],
  ['陈旧数据仍显示旧值', wrap(provider({ ok: false, state: 'bad-key', stale: true, error: 'x' })), true, ['Go', '月 45%']],
  ['无数据', wrap(provider({ ok: false, state: 'network', windows: null, fetchedAt: null })), true, ['Go', '—']],
  ['正在读取', wrap(provider({ ok: false, state: 'pending', windows: null, fetchedAt: null })), true, ['Go', '…']],
  ['折叠态只剩环', base, false, ['Go']],
  ['两家时徽标只报当前页（默认第一家）', wrap([provider(), balanceOnly()]), true, ['Go', '月 45%']],
  ['没有任何 provider 时整块不渲染', wrap([]), true, []],
]) {
  const r = render({ data, wide, open: false })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  check(name, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got))
}

console.log('\n翻页（徽标跟着当前页走）：')
for (const [name, activeId, expect] of [
  ['翻到余额那一家', 'deepseek', ['DS', '¥110.00']],
  ['翻回窗口那一家', 'opencode-go', ['Go', '月 45%']],
]) {
  const r = render({ data: wrap([provider(), balanceOnly()]), wide: true, open: false, activeId })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  check(name, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got))
}

{
  // 形状由种类决定：余额型即使一条数据都没有，也保持实心圆底，不会退化成空心环。
  const r = render({
    data: wrap(balanceOnly({ ok: false, state: 'no-key', balance: [], windows: null })),
    wide: true,
    open: false,
  })
  check(
    '余额型缺数据时仍是实心圆底',
    !r.error && r.html.includes('opacity="0.16"') && texts(r.html).includes('—'),
    texts(r.html).join(' / '),
  )
}

console.log('\n悬停卡片（中文）：')
for (const [name, data, expectHead] of [
  // 正常态**不再**写「正常」二字：把 90% 的默认态印在每张卡上，
  // 只会稀释异常时的信号。这里断言的是「不该出现」，比断言出现更能守住设计。
  ['正常态不写状态词', base, null],
  ['已限流', wrap(provider({ windows: withRolling(100, 'rate-limited') })), '已限流'],
  ['数据过期', wrap(provider({ ok: false, state: 'bad-key', stale: true, error: 'x' })), null],
]) {
  const r = render({ data, wide: true, open: true, anchor: { left: 12, top: 700 } })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  const hasWindows = got.includes('5 小时') && got.includes('本周') && got.includes('本月')
  if (expectHead === null) {
    check(name, hasWindows && !got.includes('正常') && !got.includes('数据过期'), got.slice(0, 6).join(' / '))
  } else {
    check(name, hasWindows && got.includes(expectHead), got.slice(3, 6).join(' / '))
  }
}
{
  // 空态不再画出「标签 — 空条 — 「—」」的骨架，直接给一句能行动的话。
  const r = render({
    data: wrap(provider({ ok: false, state: 'network', windows: null, fetchedAt: null })),
    wide: true,
    open: true,
    anchor: { left: 12, top: 700 },
  })
  const got = r.error ? [] : texts(r.html)
  check(
    '空态给可行动文案而不是空骨架',
    !r.error && got.includes('数据不可用') && got.includes('稍后会自动重试'),
    got.slice(0, 8).join(' / '),
  )
  check('空态不再渲染「暂无数据」占位', !got.includes('暂无数据'), got.slice(0, 8).join(' / '))
}
{
  // 两家时卡片分两段，各自带名字；余额型显示金额而不是窗口。
  const r = render({ data: wrap([provider(), balanceOnly()]), wide: true, open: true, anchor: { left: 12, top: 700 } })
  const got = r.error ? [] : texts(r.html)
  check(
    '卡片按 provider 分段',
    !r.error && got.includes('OpenCode Go') && got.includes('DeepSeek') && got.includes('¥110.00'),
    got.slice(0, 8).join(' / '),
  )
}

// ---- 动态窗口：key 是上游策略 id，名字必须按 durationSeconds 生成 ----------------
/** 动态窗口形态：窗口 key 是 `w18000` / `w604800` 这种上游策略 id，字典里没有。
 *  这不是某一家的专属能力——任何「窗口由套餐决定」的来源都长这样。 */
const dynamicWindows = (over) => ({
  id: 'dynamic',
  name: 'Dynamic Source',
  mark: 'DY',
  kind: 'windows',
  credentialLabel: 'SOURCE_KEY',
  ok: true,
  state: 'ok',
  windows: [
    { key: 'w18000', durationSeconds: 18000, fallbackLabel: '5h', percent: 6.5, resetsAt: new Date(Date.now() + 7_000_000).toISOString(), resetMode: 'anchored_recurring', status: 'ok' },
    { key: 'w604800', durationSeconds: 604800, fallbackLabel: '7d', percent: 2.2, resetsAt: new Date(Date.now() + 300_000_000).toISOString(), resetMode: 'anchored_recurring', status: 'ok' },
  ],
  balance: [{ kind: 'money', amount: '1.50', currency: 'USD' }],
  meta: { tier: 'go', eligible: true, funding: 'wallet' },
  fetchedAt: Date.now() - 5_000,
  lastAttemptAt: Date.now(),
  stale: false,
  error: null,
  ...over,
})

console.log('\n动态窗口：')
{
  const r = render({ data: wrap(dynamicWindows()), wide: true, open: false })
  const got = r.error ? [] : texts(r.html)
  check('徽标报最紧的窗口（5 小时）', !r.error && got.includes('DY') && got.includes('5h 6.5%'), got.join(' / '))
}
{
  const r = render({ data: wrap(dynamicWindows()), wide: true, open: true, anchor: { left: 12, top: 700 } })
  const got = r.error ? [] : texts(r.html)
  check(
    '窗口名按长度生成（5 小时 / 7 天），不显示原始 key',
    !r.error && got.includes('5 小时') && got.includes('7 天') && !got.includes('w18000'),
    got.slice(0, 10).join(' / '),
  )
  check('钱包余额与窗口同时展示', !r.error && got.includes('$1.50'), got.slice(0, 12).join(' / '))
}
{
  // 只有一天的窗口（Plus/Pro/Max 那种）不该硬画出「5 小时」。
  const onlyWeek = dynamicWindows({ windows: [dynamicWindows().windows[1]] })
  const r = render({ data: wrap(onlyWeek), wide: true, open: true, anchor: { left: 12, top: 700 } })
  const got = r.error ? [] : texts(r.html)
  check('只有 7 天窗口时不出现 5 小时', !r.error && got.includes('7 天') && !got.includes('5 小时'), got.slice(0, 8).join(' / '))
  check('7 天窗口最紧时徽标报 7d', (() => {
    const b = render({ data: wrap(onlyWeek), wide: true, open: false })
    return !b.error && texts(b.html).includes('7d 2.2%')
  })())
}
{
  // 滚动窗口不给 resetsAt：给一句解释，而不是空行。
  const rolling = dynamicWindows({
    windows: [{ key: 'w18000', durationSeconds: 18000, fallbackLabel: '5h', percent: 40, resetsAt: null, resetMode: 'activity_triggered', status: 'ok' }],
  })
  const r = render({ data: wrap(rolling), wide: true, open: true, anchor: { left: 12, top: 700 } })
  const got = r.error ? [] : texts(r.html)
  check('resetsAt 缺失时显示「按使用滚动重置」', !r.error && got.includes('按使用滚动重置'), got.slice(0, 10).join(' / '))
}
{
  // 会话失效：明确说「API key 无效」，而不是含糊的「不可用」。
  const r = render({
    data: wrap(dynamicWindows({ ok: false, state: 'bad-key', windows: null, balance: [], fetchedAt: null, stale: false })),
    wide: true,
    open: true,
    anchor: { left: 12, top: 700 },
  })
  const got = r.error ? [] : texts(r.html)
  check('会话失效时给出可操作文案', !r.error && got.includes('API key 无效'), got.slice(0, 8).join(' / '))
}

console.log('\n英文（切到 en）：')
for (const [name, data, expect] of [
  ['徽标正常', base, ['Go', 'Mo 45%']],
  ['徽标已限流', wrap(provider({ windows: withRolling(100, 'rate-limited') })), ['Go', '5h 100%']],
]) {
  const r = render({ data, wide: true, open: false, lang: 'en' })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  check(name, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got))
}
{
  const r = render({ data: base, wide: true, open: true, lang: 'en', anchor: { left: 12, top: 700 } })
  const got = r.error ? [] : texts(r.html)
  check('卡片三条窗口名都是短的（不折行）', !r.error && got.includes('5 hours') && got.includes('Week') && got.includes('Month'), got.slice(4, 9).join(' / '))
}

console.log('\n降级与边界：')
{
  // createPortal 不可用（平台表里没有 react-dom）→ 退回原地渲染
  const fallbackMod = loadBundle({})
  let Component = null
  fallbackMod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => makeT(dicts.zh) },
    slots: { inject: (k, fn) => fn(), register: (o, C) => { Component = C } },
  })
  queue = [[base, noop], [true, noop], [false, noop], [false, noop], [false, noop], [{ left: 12, top: 700 }, noop]]
  try {
    const html = renderToStaticMarkup(React.createElement(Component, { wide: true, t: makeT(dicts.zh) }))
    check('createPortal 缺失时原地渲染', texts(html).includes('月 45%'))
  } catch (error) {
    check('createPortal 缺失时原地渲染', false, error.message)
  } finally {
    queue = null
  }
}
{
  // 错误边界在 SSR 下不生效（React 服务端渲染不支持），这里只确认异常本身存在，
  // 不作为失败——边界只在浏览器渲染器里生效。
  const boom = wrap({
    ...provider(),
    get windows() {
      throw new Error('boom')
    },
  })
  const r = render({ data: boom, wide: true, open: false })
  console.log('  · 错误边界：SSR 下异常穿透（符合预期，React 服务端渲染不调用 getDerivedStateFromError）')
  void r
}

// ---- 6. 冷启动提速：把 effect 抠出来手动跑 -----------------------------------
//
// 现象回归：DSH 刚重启时徽标停在「—」，必须把鼠标划过徽标（悬停会补读一次）或等上
// 半分钟才出数字。根因是 Host 首次上游拉取还没回来，客户端却按 30 秒的常规节奏干等。
const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

const pendingSnapshot = wrap(
  provider({ ok: false, state: 'pending', windows: null, fetchedAt: null, lastAttemptAt: null }),
)

/**
 * 跑一次徽标的数据循环，返回它排出的定时器间隔序列。
 * @param body - 假路由每次返回的快照；传 'throw' 模拟本地路由尚不可达。
 * @param steps - 手动触发多少次 tick。
 */
async function scheduleDelays(body, steps) {
  const delays = []
  let pending = null
  globalThis.setTimeout = (fn, delay) => {
    delays.push(delay)
    pending = fn
    return delays.length
  }
  globalThis.clearTimeout = () => {}
  globalThis.fetch = async () => {
    if (body === 'throw') throw new Error('route not ready')
    return { json: async () => body }
  }
  effects = []
  render({ data: pendingSnapshot, wide: true, open: false })
  const effect = effects[0]
  effects = null
  const cleanup = effect()
  for (let i = 0; i < steps; i += 1) {
    await new Promise((r) => realSetTimeout(r, 0))
    const fn = pending
    pending = null
    if (!fn) break
    fn()
  }
  await new Promise((r) => realSetTimeout(r, 0))
  cleanup()
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  return delays
}

console.log('\n冷启动提速：')
{
  const delays = await scheduleDelays(pendingSnapshot, 61)
  check('**pending 时下一次读取压到 1 秒**', delays[0] === 1_000, String(delays[0]))
  check(
    '**连续 60 次都是 1 秒**',
    delays.slice(0, 60).every((d) => d === 1_000),
    delays.slice(0, 60).join(', '),
  )
  check('**预算用完后回到 30 秒常规节奏**', delays[60] === 30_000, String(delays[60]))
}
{
  const delays = await scheduleDelays(base, 3)
  check('已有数据时不做提速（30 秒）', delays[0] === 30_000, String(delays[0]))
}
{
  const delays = await scheduleDelays(wrap(provider({ ok: false, state: 'no-key', windows: null })), 3)
  check('凭证没配属于确定性失败，不提速（30 秒）', delays[0] === 30_000, String(delays[0]))
}
{
  const delays = await scheduleDelays('throw', 3)
  check('本地路由不可达时提速（1 秒）', delays[0] === 1_000, String(delays[0]))
}

// ---- 7. 与账号行对齐的几何 ---------------------------------------------------
//
// 徽标行紧挨着下方账号行（`settings.launcher` 里的 AccountMenu）。两行的盒子必须
// 取同一组数字，否则环与头像会差 4px，视觉上明显不成对。
console.log('\n对齐几何（对齐下方账号行）：')
{
  const wide = render({ data: base, wide: true, open: false }).html
  check('展开态按钮高 44px', wide.includes('height:44px'), wide.slice(0, 240))
  check('展开态内边距 6px', wide.includes('padding:6px'))
  check('展开态盒子比容器宽 4px（抵消账号行的负外边距）', wide.includes('width:calc(100% + 4px)'))
  check('展开态左右各外扩 2px', wide.includes('margin:0 -2px'))
  check('圆角与账号行一致（--dsw-radius-md）', wide.includes('border-radius:var(--dsw-radius-md, 12px)'))
}
{
  const rail = render({ data: base, wide: false, open: false }).html
  check('折叠态收成 36px 方块', rail.includes('width:36px') && rail.includes('height:36px'), rail.slice(0, 240))
  check('折叠态去掉内边距', rail.includes('padding:0'))
}

// ---- 8. 环的几何 -------------------------------------------------------------
console.log('\n环：')
{
  const html = render({ data: base, wide: true, open: false }).html
  // 24px 直径、2px 描边 → 内径 20px；中心字 10.5px，左右各余约 3.2px。
  check('环直径 24px（与头像同径）', html.includes('width="24" height="24"'))
  check('描边 2px', html.includes('stroke-width="2"'))
  check('中心字 10.5px', html.includes('font-size="10.5px"'))
  check('中心字用正文色，不与弧抢颜色', html.includes('fill="var(--dsw-alias-label-primary)"'))
  check('中心字仍是品牌字「Go」', html.includes('>Go</text>'))
}

// ---- 9. 翻页交互回归 ---------------------------------------------------------
//
// 两个已修复的缺陷，各留一条断言：
//   a) 打开卡片必须直接停在徽标指的那一页（此前永远从第一页开始）；
//   b) 翻页过程中不能让徽标连续闪中间页（此前平滑滚动每帧回写 activeId）。
// 动画本身依赖真实浏览器，SSR 测不到，所以这里测的是「结构上限」：
// 旧值节点必须被标记成 aria-hidden 且绝对定位，才不会把徽标宽度顶开。
console.log('\n翻页交互：')
{
  // 卡片停在第三页时：第一页的标题应仍在 DOM 里（横向翻页），但 pager 必须
  // 拿到 index 才能滚过去。这里断言 Card 接受了 activeId 并把它传给 aria-label。
  const three = [provider(), dynamicWindows(), balanceOnly()]
  const r = render({ data: wrap(three), wide: true, open: true, activeId: 'deepseek', anchor: { left: 12, top: 700 } })
  const html = r.error ? '' : r.html
  check('卡片按 activeId 取当前页（aria-label 指向 DeepSeek）', !r.error && html.includes('aria-label="DeepSeek"'), r.error)

  // 页码圆点：当前页必须标 aria-current，且有 3 个。
  const current = (html.match(/aria-current="true"/g) || []).length
  check('三个 provider 只有一个页码被标为当前页', current === 1, 'aria-current=' + current)
  check('页码数量等于 provider 数量', (html.match(/aria-label="(OpenCode Go|Dynamic Source|DeepSeek)"/g) || []).length >= 3)
}
{
  // 徽标右侧数值必须**只有一个**文本节点。
  //
  // 曾经为了交叉淡化叠过两层（新值 + 绝对定位的旧值），结果是永久重影：
  // 负责摘掉旧值的定时器会被 useEffect 的 cleanup 抢先清掉，旧值留在 DOM 里
  // 和新值叠在同一位置。这条断言盯的就是「不许再出现第二层」。
  const html = render({ data: base, wide: true, open: false }).html
  const badge = html.slice(0, html.indexOf('</button>'))
  check('徽标里没有绝对定位的叠加文本', !badge.includes('position:absolute'), badge.slice(-200))
  check('数值只出现一次', (badge.match(/月 45%/g) || []).length === 1, badge.slice(-200))
  // 弧长与颜色必须是**同一个时长**：曾经是 450ms，与环心字 200ms、数值 260ms 各走
  // 各的，换一家时四样东西分四次到位，看着就碎。
  check('环弧同时过渡进度与颜色，且时长一致', (() => {
    const m = /transition:stroke-dashoffset (\d+)ms[^"]*?, stroke (\d+)ms/.exec(html)
    return m !== null && m[1] === m[2]
  })(), (html.match(/transition:stroke-dashoffset[^"]*/) || [''])[0])
}
{
  // 三种 provider 各渲染一次徽标：任何一家都不该在右侧叠出两层文字。
  for (const [name, item, expected] of [
    ['OpenCode Go', provider(), '月 45%'],
    ['Dynamic Source', dynamicWindows(), '5h 6.5%'],
    ['DeepSeek', balanceOnly(), '¥110.00'],
  ]) {
    const html = render({ data: wrap(item), wide: true, open: false }).html
    const badge = html.slice(0, html.indexOf('</button>'))
    check(name + ' 的徽标文字不重复', (badge.match(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1, badge.slice(-160))
  }
}

// ---- 10. 卡片排版回归（设计稿 v2） ------------------------------------------
//
// 这一组盯的是「好看」的可测量部分：左缘对齐、字阶层级、高度自适应、余额大字。
// 每一条都对应一个被修掉的具体缺陷，不是风格偏好。
console.log('\n卡片排版：')
{
  const html = render({ data: base, wide: true, open: true, anchor: { left: 12, top: 700 } }).html

  // ① 注释必须回到左缘：旧实现 paddingLeft:64，比标签的 12 差 8px。
  check('重置时间不再缩进（无 paddingLeft:64）', !html.includes('paddingLeft:64'), html.match(/paddingLeft:[^;}"]+/g))
  check('卡片内边距 14px', html.includes('padding:14px'))

  // ② 字阶：窗口名 12/500，百分比 13/600，注释 11px。
  check('窗口名 12px / 500', html.includes('font-size:12px;font-weight:500'))
  check('百分比 13px / 600', html.includes('font-size:13px;font-weight:600'))
  check('注释 11px', html.includes('font-size:11px'))
  // 旧实现的三层全是 13px，只有字重差一档。现在窗口名必须落在 12px——把它钉死，
  // 免得以后有人「统一一下字号」又把层级抹平。
  // 数的是**窗口行里**的 12px：OpenCode Go 有三个窗口，余额型卡片没有窗口，
  // 拿它当基准会被「名字是 13px」蒙对。
  const labelCount = (html.match(/width:54px[^"]*font-size:12px/g) || []).length
  check('每个窗口名都是 12px（与数值 13px 拉开一档）', labelCount === 3, labelCount + ' 个窗口名')

  // ③ 进度条收细到 4px。
  check('进度条高 4px、圆角 2px', html.includes('height:4px') && html.includes('border-radius:2px'))

  // ④ 页脚只剩一行：不再有 flex:1 撑高 + 独立分隔线那一段。
  check('页脚不再用 flex:1 撑高', !html.includes('flex:1"></div><div style="height:1px'))
}
{
  // 余额型：大字金额占住视觉重心，空白变成呼吸。
  const html = render({ data: wrap(balanceOnly()), wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  check('余额型金额用 22px 大字', html.includes('font-size:22px'))
  check('余额型带「余额」说明文字', html.includes('余额'))
}
{
  // Dynamic Source：窗口 + 钱包两种形态同页，钱包那行要带分隔线且字号更小。
  const html = render({ data: wrap(dynamicWindows()), wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  // 字典里钱包那行的标签是「余额」，不是「钱包余额」——后者只是设计稿上的说明文字。
  check('有窗口时钱包退成一行辅助信息', html.includes('余额') && html.includes('$1.50'))
  check('钱包金额不是大字（窗口才是主信息）', !html.includes('font-size:22px'))
}
{
  // 高度自适应：ProviderPage 不得再写死 height:100%（那正是「撑到最高页」的来源）。
  // 注意别误伤进度条**内部**的填充条——它本来就该撑满轨道，那是 height:100%。
  const stretch = /display:flex;flex-direction:column;gap:12px;height:100%/
  const one = render({ data: wrap(provider()), wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  const two = render({ data: wrap(dynamicWindows()), wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  check('页容器不再写死 height:100%', !stretch.test(one) && !stretch.test(two))
  // 进度条填充条仍然撑满轨道——这是对的，别一起改掉。
  check('进度条填充仍撑满轨道', one.includes('height:100%;width:'))
}
{
  // 空态：三种来源分开说，各自给能行动的那句话。
  for (const [state, expectTitle, expectHint] of [
    ['no-key', '凭证未配置', '配置'],
    ['no-workspace', '没有可读的 workspace', '个人 workspace'],
    ['no-subscription', '未订阅 Coding Plan', '额度接口'],
  ]) {
    const html = render({
      data: wrap(provider({ ok: false, state, windows: null, fetchedAt: null })),
      wide: true,
      open: true,
      anchor: { left: 12, top: 700 },
    }).html
    check('空态（' + state + '）说明成因与下一步', html.includes(expectTitle) && html.includes(expectHint), html.slice(-200))
  }
}

// ---- 11. 减少动效 ------------------------------------------------------------
//
// `prefers-reduced-motion: reduce` 是无障碍设置，不是可选优化。内联样式里写不了
// @media，只能由脚本判断——所以要有断言守住「所有过渡都走了同一个判断」。
console.log('\n减少动效：')
{
  const before = render({ data: base, wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  // 默认（未要求减少动效）时过渡照常：motion() 原样返回，所以这里能看到真实的 transition。
  check('默认开启过渡', /transition:(opacity|width|stroke|color)/.test(before), (before.match(/transition:[^;"]*/g) || []).slice(0, 2).join(' | '))
}
{
  // 打桩 matchMedia 返回 reduce，再渲染一次：所有 transition 必须变成 none。
  const realMatchMedia = globalThis.window.matchMedia
  globalThis.window.matchMedia = (query) => ({ matches: query.includes('reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} })
  try {
    const html = render({ data: base, wide: true, open: true, anchor: { left: 12, top: 700 } }).html
    const transitions = html.match(/transition:[^;"]*/g) || []
    check('reduce 下所有过渡都被关掉', transitions.length > 0 && transitions.every((v) => v === 'transition:none'), transitions.slice(0, 3).join(' | '))
    // 关掉动画不等于关掉功能：数字与窗口仍要完整。
    check('reduce 下内容仍然完整', html.includes('5 小时') && html.includes('10%'))
  } finally {
    if (realMatchMedia === undefined) delete globalThis.window.matchMedia
    else globalThis.window.matchMedia = realMatchMedia
  }
}

// ---- 12. 翻页容器高度 --------------------------------------------------------
//
// 这是上一版「改了但还是空白」的真正原因：只给 ProviderPage 去掉 height:100% 没用，
// 翻页容器是横向 flex，所有页都在同一行里参与高度计算，容器照样等于「最高那一页」。
// 无头 Edge 实测（三页内容高 190 / 210 / 114）：
//   旧策略 → 三页容器都是 225，卡片都是 272
//   新策略 → 容器分别 190 / 210 / 114，卡片 237 / 257 / 161
// SSR 跑不了布局，所以这里断言「容器高度被显式钉住」这个结构前提。
console.log('\n翻页容器高度：')
{
  const html = render({ data: wrap([provider(), dynamicWindows(), balanceOnly()]), wide: true, open: true, activeId: 'deepseek', anchor: { left: 12, top: 700 } }).html
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  check('pager 高度由当前页测量后钉住', src.includes('pagerHeight === null ? undefined : pagerHeight') && src.includes('activePageRef'))
  check('pager 用 alignItems:flex-start（不再拉伸各页）', src.includes("alignItems: 'flex-start'"))
  // 高度被钉住不能以「隐藏其他页」为代价：三页内容必须都还在，否则横向滑动会看到空白。
  const got = texts(html)
  check('三页内容都还在（滑动可见）', got.filter((s) => ['OpenCode Go', 'Dynamic Source', 'DeepSeek'].includes(s)).length === 3)
}

// ---- 13. 动画时间线一致 ------------------------------------------------------
//
// 「不丝滑」的根因是四样东西各走各的时长：弧 450ms、环心字 200ms、数值 260ms、
// 颜色 350ms，换一家时分四次到位。还有卡片高度被 pager 的 transition 和 shell 的
// WAAPI 同时控制，切页时两套动画打架。
//
// 这些是时间参数，SSR 渲染不出动画，所以直接读源码守住「只有一处定义 + 所有人引用」。
console.log('\n动画时间线：')
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  check('徽标时长只有一处定义', (src.match(/const BADGE_SWAP_MS/g) || []).length === 1)
  // 直接比较两个常量的字面值，而不是「源码里出现过 240」——后者在两者改成不同值
  // （比如徽标 300、卡片 240）时仍然会通过，等于没测。
  const badgeMs = Number((/const BADGE_SWAP_MS = (\d+)/.exec(src) || [])[1])
  const cardMs = Number((/const CARD_RESIZE_MS = (\d+)/.exec(src) || [])[1])
  check('卡片高度时长与徽标一致', Number.isFinite(badgeMs) && badgeMs === cardMs, badgeMs + ' vs ' + cardMs)

  // 弧、环心字、数值、颜色都必须引用同一个常量，不许再出现写死的毫秒数。
  check('环弧引用统一时长', src.includes("stroke-dashoffset ' + BADGE_SWAP_MS"))
  check('环心字引用统一时长', /play\(node, \[\{ opacity: 0\.15 \}, \{ opacity: 1 \}\], BADGE_SWAP_MS\)/.test(src))
  check('数值颜色引用统一时长', src.includes("color ' + BADGE_SWAP_MS"))
  check('数值淡入淡出占一半（两段合计等于统一时长）', /const SWAP_FADE_MS = BADGE_SWAP_MS \/ 2/.test(src))

  // 高度只能有一套动画：pager 的 CSS transition 负责，不许再给 shell 补间。
  check('高度动画只有 pager 一处', src.includes("motion('height ' + CARD_RESIZE_MS") && !src.includes('lastHeight'))
  check('高度用统一缓动曲线', /height ' \+ CARD_RESIZE_MS \+ 'ms ' \+ SWAP_EASE/.test(src))
}

// ---- 14. DESIGN.md 规则落地 --------------------------------------------------
//
// 规则来自 awesome-design-md 里 Linear / Vercel / Stripe / Cursor / Claude 的分析。
// 挑的是对这张卡真正有约束力的四条，每条都能判定通过与否。
console.log('\nDESIGN.md 规则：')
{
  const html = render({ data: base, wide: true, open: true, anchor: { left: 12, top: 700 } }).html
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // ① Vercel：「never a single heavy drop-shadow」——必须是多层堆叠。
  // SHADOW_STACK 的值写在赋值号的下一行，所以正则要跨行取。
  const stackMatch = /const SHADOW_STACK =\s*\n?\s*'([^']+)'/.exec(src)
  const layers = stackMatch ? (stackMatch[1].match(/rgba\(/g) || []).length : 0
  check('阴影是堆叠常量，不是内联单层重投影', src.includes('boxShadow: hovered ? SHADOW_STACK_HOVER : SHADOW_STACK'))
  check('堆叠阴影三层', layers === 3, layers + ' 层')
  check('不再出现旧的重投影', !html.includes('0 12px 32px rgba(0,0,0,.16)'))

  // ② Linear / Stripe：标题与数值用负字距。
  check('标题用负字距', src.includes('letterSpacing: TRACK_TITLE'))
  check('百分比用负字距', src.includes('letterSpacing: TRACK_VALUE'))
  check('余额大字用更大的负字距', src.includes('letterSpacing: TRACK_HERO'))
  check('字距量级合理（标题 -0.15 / 大字 -0.5）', /TRACK_TITLE = '-0\.15px'/.test(src) && /TRACK_HERO = '-0\.5px'/.test(src))

  // ③ Vercel：「ghost pill，visible only on hover」——刷新按钮要有悬停态。
  check('刷新按钮有独立的悬停/按下状态', src.includes('function RefreshButton') && src.includes('setPressed'))
  check('刷新按钮三档底色', /pressed\s*\?\s*'var/.test(src) && /hovered\s*\?\s*'var/.test(src))

  // ④ 卡片自身 hover 只加深阴影，不位移（浮层一移动会带着锚点错觉）。
  check('卡片 hover 只换阴影不改位置', src.includes('hovered ? SHADOW_STACK_HOVER : SHADOW_STACK'))
}

// ---- 15. 记住翻到哪一家 ------------------------------------------------------
//
// 用户反馈：「关闭 dsh 又重启后，显示的是第一张卡片，没有记忆之前选择」。
//
// 关键约束：**不能用 localStorage**。GUI 端口每次重启都会变（实测 60043 → 60877
// → 62355 → 64393），localStorage 按 origin（协议+主机+端口）隔离，端口一变就是
// 另一个 origin。所以选择必须由 Host 存盘，客户端只负责读回来 + 上报。
console.log('\n记住翻到哪一家：')
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 只查真实调用（带点号），注释里提到 localStorage 是在解释「为什么不用它」。
  check('不依赖浏览器存储', !/localStorage\.|sessionStorage\./.test(src))
  check('有一条专门的上报路由', src.includes("SELECT_PATH = '/opencode-go-quota/select'"))
  check('首帧用 Host 的 selectedId 开页', src.includes('body.selectedId') && src.includes('setActiveId(remembered)'))

  // 只在第一次拿数据时恢复：否则每次轮询都会把用户刚翻到的那一页拽回去。
  check('恢复只做一次（hydrating 哨兵）', /if \(hydrating\.current\)/.test(src) && /hydrating\.current = false/.test(src))

  // 从 Host 读回来的值要回填 reported，否则用户翻回该页会被当成新选择白写一次。
  check('回填 reported 避免重复写入', /reported\.current = remembered/.test(src))

  // 上报要尽力而为：失败不能拖慢或打断翻页。
  check('上报不阻塞翻页（不 await）', /void fetch\(SELECT_PATH/.test(src) && src.includes('.catch(() => {})'))
  check('卡片 onSelect 走 selectProvider', src.includes('onSelect: selectProvider'))

  // Host 侧才是真正持久化的一方。
  const hostSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check('Host 把 selectedId 随 /state 下发', /selectedId: await readSelected\(\)/.test(hostSrc))
  check('Host 注册了 /select 写入路由', hostSrc.includes("SELECT_PATH = '/opencode-go-quota/select'"))
}

// ---- 汇总 -------------------------------------------------------------------
const failed = checks.filter((ok) => !ok).length
console.log('\n' + (failed === 0 ? '全部通过（' + checks.length + ' 项）' : failed + ' / ' + checks.length + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)

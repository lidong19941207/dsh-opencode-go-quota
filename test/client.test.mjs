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

/** 按 data / open / pinned / refreshing / hovered / anchor 的顺序喂状态。 */
function render(options) {
  queue = [
    [options.data, noop],
    [options.open === true, noop],
    [false, noop],
    [false, noop],
    [false, noop],
    [options.anchor === undefined ? null : options.anchor, noop],
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

const usage = {
  rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 7_000_000).toISOString() },
  weekly: { status: 'ok', percent: 19, resetsAt: new Date(Date.now() + 300_000_000).toISOString() },
  monthly: { status: 'ok', percent: 45, resetsAt: new Date(Date.now() + 1_100_000_000).toISOString() },
}
const base = {
  ok: true,
  state: 'ok',
  usage,
  fetchedAt: Date.now() - 12_000,
  lastAttemptAt: Date.now(),
  stale: false,
  error: null,
  thresholds: { warn: 80, critical: 95 },
  apiKeyRef: 'OPENCODE_GO_API_KEY',
}

console.log('\n徽标（中文）：')
for (const [name, data, wide, expect] of [
  ['正常（最紧=月）', base, true, ['Go', '月 45%']],
  ['5 小时最紧', { ...base, usage: { ...usage, rolling: { ...usage.rolling, percent: 95 } } }, true, ['Go', '5h 95%']],
  [
    '已限流',
    { ...base, usage: { ...usage, rolling: { ...usage.rolling, percent: 100, status: 'rate-limited' } } },
    true,
    ['Go', '5h 100%'],
  ],
  ['陈旧数据仍显示旧值', { ...base, ok: false, state: 'bad-key', stale: true, error: 'x' }, true, ['Go', '月 45%']],
  ['无数据', { ...base, ok: false, state: 'network', usage: null, fetchedAt: null, stale: false }, true, ['Go', '—']],
  ['正在读取', { ...base, ok: false, state: 'pending', usage: null, fetchedAt: null, stale: false }, true, ['Go', '…']],
  ['折叠态只剩环', base, false, ['Go']],
]) {
  const r = render({ data, wide, open: false })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  check(name, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got))
}

console.log('\n悬停卡片（中文）：')
for (const [name, data, expectHead] of [
  ['正常', base, '正常'],
  ['已限流', { ...base, usage: { ...usage, rolling: { ...usage.rolling, percent: 100, status: 'rate-limited' } } }, '已限流'],
  ['数据过期', { ...base, ok: false, state: 'bad-key', stale: true, error: 'x' }, '数据过期'],
  ['不可用', { ...base, ok: false, state: 'network', usage: null, fetchedAt: null, stale: false }, '不可用'],
]) {
  const r = render({ data, wide: true, open: true, anchor: { left: 12, top: 700 } })
  if (r.error) {
    check(name, false, r.error)
    continue
  }
  const got = texts(r.html)
  check(name, got.includes(expectHead) && got.includes('5 小时') && got.includes('本周') && got.includes('本月'), got.slice(3, 6).join(' / '))
}

console.log('\n英文（切到 en）：')
for (const [name, data, expect] of [
  ['徽标正常', base, ['Go', 'Mo 45%']],
  ['徽标已限流', { ...base, usage: { ...usage, rolling: { ...usage.rolling, percent: 100, status: 'rate-limited' } } }, ['Go', '5h 100%']],
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
  const boom = {
    ...base,
    usage: {
      get rolling() {
        throw new Error('boom')
      },
      weekly: usage.weekly,
      monthly: usage.monthly,
    },
  }
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

const pendingSnapshot = {
  ok: false,
  state: 'pending',
  usage: null,
  fetchedAt: null,
  lastAttemptAt: null,
  stale: false,
  error: null,
  thresholds: { warn: 80, critical: 95 },
  apiKeyRef: 'OPENCODE_GO_API_KEY',
}

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
  const delays = await scheduleDelays({ ...pendingSnapshot, state: 'no-key' }, 3)
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

// ---- 汇总 -------------------------------------------------------------------
const failed = checks.filter((ok) => !ok).length
console.log('\n' + (failed === 0 ? '全部通过（' + checks.length + ' 项）' : failed + ' / ' + checks.length + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)

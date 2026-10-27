/**
 * 额度监控 — Host 半边。
 *
 * 职责：
 *  1. 按注册表装配 provider，各自解析凭证；
 *  2. 每个 provider 一个自调度轮询（故障互不影响）；
 *  3. 通过 ctx.webServer 暴露一个同源只读路由，把**所有 provider 的快照**一起下发。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：插件装在 profile 目录下，那里解析不到
 * 内部包。CredentialRef / Service 在运行时都只是字符串，品牌仅在类型层。
 */
import { resolveCredential } from './credentials.js'
import { CredentialError } from './errors.js'
import { PROVIDERS } from './providers/index.js'
import { createScheduler } from './scheduler.js'
import { readSelected, writeSelected } from './prefs.js'

/** 浏览器半边取数的同源路由（exact 路由优先于 dsh-client-modules 的 /plugins 前缀）。 */
const STATE_PATH = '/opencode-go-quota/state'
/** 记住「用户翻到哪一家」。与取数分开，避免轮询把选择冲掉。 */
const SELECT_PATH = '/opencode-go-quota/select'

export const name = 'opencode-go-quota'

/** 需要的 Host 服务：HTTP 载体、请求信任策略、凭证。 */
export const inject = ['webServer', 'connection', 'credentials']

/** 全局默认配置；provider 级的同名字段优先。 */
const DEFAULTS = {
  /** 轮询间隔（秒），下限 30。 */
  pollIntervalSec: 300,
  /** 连续失败时的退避上限（秒），默认 30 分钟。 */
  maxBackoffSec: 1800,
  /** 警告阈值（%）。 */
  warnPercent: 80,
  /** 危急阈值（%）。 */
  criticalPercent: 95,
}

/**
 * 0.1.x 的扁平配置（`apiKeyRef` / `baseUrl` 写在顶层）视为第一家 provider 的覆盖，
 * 这样老配置升级后不用改也能跑。
 * @param cfg - 顶层配置。
 */
function legacyOverrides(cfg) {
  const out = {}
  if (cfg.apiKeyRef !== undefined) out.apiKeyRef = cfg.apiKeyRef
  if (cfg.baseUrl !== undefined) out.baseUrl = cfg.baseUrl
  return out
}

/**
 * 组合某个 provider 的最终配置：适配器默认值 ← 旧扁平配置 ← providers.<id>。
 * @param cfg - 顶层配置。
 * @param adapter - provider 模块。
 * @param index - 在注册表里的序号。
 */
function providerConfig(cfg, adapter, index) {
  const scoped = (cfg.providers && cfg.providers[adapter.id]) || null
  const legacy = !cfg.providers && index === 0 ? legacyOverrides(cfg) : {}
  return { ...adapter.defaults, ...legacy, ...(scoped || {}) }
}

/**
 * 解析凭证并拉一次。
 *
 * `credential()` 声明「从哪取」，`resolveCredential()` 负责取回来；
 * 这里只负责判断「拿到了没」。
 * @param ctx - Cordis 上下文。
 * @param adapter - provider 模块。
 * @param cfg - 已组合好的 provider 配置。
 * @throws CredentialError - 凭证缺失或读不到，调度器会把它归成 no-key。
 */
async function pollOnce(ctx, adapter, cfg) {
  const key = await resolveCredential(adapter.credential(cfg), ctx)
  if (!key || (typeof key === 'string' && key.length === 0)) {
    throw new CredentialError('凭证 ' + adapter.credentialHint(cfg) + ' 未配置')
  }
  return adapter.poll({ cfg, key, fetchImpl: fetch })
}

/**
 * 从请求 URL 里读出要刷新的目标。
 * @param url - req.url，例如 `/opencode-go-quota/state?refresh=opencode-go`。
 * @returns null（不刷新）/ 'all' / provider id。
 */
function refreshTarget(url) {
  const query = (url || '').split('?')[1]
  if (!query) return null
  const match = /(?:^|&)refresh=([^&]*)/.exec(query)
  if (!match) return null
  const value = decodeURIComponent(match[1] || '')
  // refresh=1 是 0.1.x 客户端的写法，含义是「全刷」。
  if (value === '' || value === '1' || value === 'all') return 'all'
  return value
}

/**
 * 安装插件。
 * @param ctx - Cordis 上下文。
 * @param config - Loader 行传入的配置覆盖。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  /** 装配结果：适配器 + 生效配置 + 自己的调度器。 */
  const entries = []
  PROVIDERS.forEach((adapter, index) => {
    const scoped = providerConfig(cfg, adapter, index)
    if (scoped.enabled === false) return
    const intervalMs = Math.max(30, Number(scoped.pollIntervalSec) || Number(cfg.pollIntervalSec) || 300) * 1000
    const maxBackoffMs = Math.max(intervalMs, (Number(scoped.maxBackoffSec) || Number(cfg.maxBackoffSec) || 1800) * 1000)
    entries.push({
      adapter,
      cfg: scoped,
      scheduler: createScheduler({
        runPoll: () => pollOnce(ctx, adapter, scoped),
        intervalMs,
        maxBackoffMs,
      }),
    })
  })

  // 每个 provider 各起一个循环：一家的失败、退避、卡死都不该影响另一家的节奏。
  for (const entry of entries) {
    entry.scheduler.start(ctx, `${name}: poll ${entry.adapter.id}`)
  }

  const body = async () => ({
    generatedAt: Date.now(),
    thresholds: { warn: cfg.warnPercent, critical: cfg.criticalPercent },
    // 上次翻到的那一家。客户端拿它做初始页，重启后就不会跳回第一张卡。
    // 放在这里而不是单独一条 GET：客户端本来就要请求 /state，省一次往返。
    selectedId: await readSelected(),
    providers: entries.map((entry) => ({
      id: entry.adapter.id,
      name: entry.adapter.name,
      mark: entry.adapter.mark,
      // 徽标形状由种类决定，与「有没有数据」无关。
      kind: entry.adapter.kind,
      credentialLabel: entry.adapter.credentialHint(entry.cfg),
      ...entry.scheduler.getSnapshot(),
    })),
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          // 复用应用统一的请求信任策略，而不是自造鉴权。
          const admission = ctx.connection.admit(req)
          if (admission && 'rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          // 手动刷新走这里，避免为了几个按钮再开一条路由。
          // 成功也要复位退避，否则用户手动刷新成功了，下一次计划轮询还在退避里。
          const target = refreshTarget(req.url)
          if (target === 'all') {
            await Promise.all(entries.map((entry) => entry.scheduler.forceRefresh()))
          } else if (target) {
            const hit = entries.find((entry) => entry.adapter.id === target)
            if (hit) await hit.scheduler.forceRefresh()
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(await body()))
        },
      }),
    `${name}: state route`,
  )

  // 记住选择。单独一条路由而不是塞进 /state：GET 的语义是无副作用，
  // 而轮询每 30 秒就会打一次 /state，混写会让缓存语义变得可疑。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SELECT_PATH,
        handler: async (req, res) => {
          const admission = ctx.connection.admit(req)
          if (admission && 'rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' })
            res.end('method not allowed')
            return
          }
          let raw = ''
          try {
            for await (const chunk of req) {
              raw += chunk
              // 一个 provider id 撑死几十字节，超过这个量直接截断，别让请求体打满内存。
              if (raw.length > 2048) break
            }
          } catch {
            res.writeHead(400)
            res.end('bad request')
            return
          }
          let id = null
          try {
            const parsed = JSON.parse(raw || '{}')
            id = typeof parsed.selectedId === 'string' ? parsed.selectedId : null
          } catch {
            res.writeHead(400)
            res.end('bad json')
            return
          }
          // 只接受当前确实存在的 provider，避免记下一个已经删掉的 id，
          // 让客户端下次启动时找不到对应页而回落到第一张。
          if (id !== null && !entries.some((entry) => entry.adapter.id === id)) {
            res.writeHead(422)
            res.end('unknown provider')
            return
          }
          await writeSelected(id)
          res.writeHead(204, { 'Cache-Control': 'no-store' })
          res.end()
        },
      }),
    `${name}: select route`,
  )
}

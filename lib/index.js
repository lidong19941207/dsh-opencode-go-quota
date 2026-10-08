/**
 * OpenCode Go 额度监控 — Host 半边。
 *
 * 职责：
 *  1. 从凭证服务读取模型设置里已在用的 opencode-go key（同一个 ref）；
 *  2. 定时轮询 https://opencode.ai/zen/go/v1/usage；
 *  3. 通过 ctx.webServer 暴露一个同源只读路由，供浏览器半边取数。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：插件装在 profile 目录下，那里解析不到
 * 内部包。CredentialRef / Service 在运行时都只是字符串，品牌仅在类型层。
 */

/** 浏览器半边取数的同源路由（exact 路由优先于 dsh-client-modules 的 /plugins 前缀）。 */
const STATE_PATH = '/opencode-go-quota/state'

/** 上游额度接口。 */
const UPSTREAM_PATH = '/zen/go/v1/usage'

export const name = 'opencode-go-quota'

/** 需要的 Host 服务：HTTP 载体、请求信任策略、凭证。 */
export const inject = ['webServer', 'connection', 'credentials']

/** 默认配置；可在 cordis.patch.yml 的 config 里覆盖。 */
const DEFAULTS = {
  /** 上游基址，接口变更时可改。 */
  baseUrl: 'https://opencode.ai',
  /** 凭证 ref，与 llm-pi-ai 的 providers.opencode-go.apiKeyEnv 保持一致。 */
  apiKeyRef: 'OPENCODE_GO_API_KEY',
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
 * 把上游失败响应归一成 UI 可读的状态码。
 * @param status - HTTP 状态码。
 * @param body - 已解析的响应体，可能为 null。
 * @returns 机器可读的状态字符串。
 */
function stateForStatus(status, body) {
  const type = body && body.error && body.error.type
  if (status === 401) return 'bad-key'
  if (status === 403 || type === 'EntitlementError') return 'no-subscription'
  if (status === 429) return 'rate-limited'
  return 'http-' + status
}

/**
 * 安装插件。
 * @param ctx - Cordis 上下文。
 * @param config - Loader 行传入的配置覆盖。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  /**
   * 最近一次快照。
   *
   * `usage` / `fetchedAt` 只记录**最后一次成功**——失败不得清空已经拿到的数据，
   * 否则上游抖一下，界面就从「45%」变成「—」。`lastAttemptAt` 与 `stale` 让界面
   * 能诚实地说「这份数据是 12 分钟前的」。
   */
  let snapshot = {
    ok: false,
    state: 'pending',
    usage: null,
    fetchedAt: null,
    lastAttemptAt: null,
    stale: false,
    error: null,
  }

  /** 连续失败次数，驱动退避；手动刷新成功也复位。 */
  let failures = 0

  /** 每次轮询都重新解析凭证，这样轮换 key 无需重启。 */
  const readKey = async () => {
    const hit = await ctx.credentials.resolve(cfg.apiKeyRef)
    return hit && hit.value ? hit.value : undefined
  }

  /**
   * 记录一次失败：保留已有的 usage / fetchedAt，只翻新失败态。
   * @param state - 归一化后的状态码。
   * @param error - 人类可读的失败原因。
   */
  const fail = (state, error) => {
    snapshot = { ...snapshot, ok: false, state, stale: snapshot.usage !== null, error }
  }

  /**
   * 拉取一次额度。任何失败都只更新快照，不抛。
   * @returns 本次是否成功。
   */
  const poll = async () => {
    snapshot = { ...snapshot, lastAttemptAt: Date.now() }

    let key
    try {
      key = await readKey()
    } catch (error) {
      fail('no-key', '读取凭证失败：' + String((error && error.message) || error))
      return false
    }
    if (!key) {
      fail('no-key', '凭证 ' + cfg.apiKeyRef + ' 未配置')
      return false
    }

    try {
      const response = await fetch(cfg.baseUrl + UPSTREAM_PATH, {
        headers: {
          Authorization: 'Bearer ' + key,
          Accept: 'application/json',
          'user-agent': 'dsh-opencode-go-quota/0.1',
        },
      })
      const body = await response.json().catch(() => null)

      if (!response.ok) {
        fail(
          stateForStatus(response.status, body),
          (body && body.error && body.error.message) || 'HTTP ' + response.status,
        )
        return false
      }

      const usage = body && body.usage
      if (!usage || !usage.rolling || !usage.weekly || !usage.monthly) {
        fail('bad-payload', '响应缺少 usage 字段')
        return false
      }

      const now = Date.now()
      snapshot = { ok: true, state: 'ok', usage, fetchedAt: now, lastAttemptAt: now, stale: false, error: null }
      return true
    } catch (error) {
      fail('network', String((error && error.message) || error))
      return false
    }
  }

  // 自调度而不是 setInterval：失败时按 2 的幂退避。401（key 失效）/ 403（没订阅）
  // 这类确定性错误若仍每 5 分钟重试一次，没有意义。
  ctx.effect(() => {
    let alive = true
    let timer = null

    const baseMs = Math.max(30, Number(cfg.pollIntervalSec) || 300) * 1000
    const maxMs = Math.max(baseMs, (Number(cfg.maxBackoffSec) || 1800) * 1000)

    const schedule = () => {
      if (!alive) return
      const delay = Math.min(maxMs, baseMs * Math.pow(2, failures))
      timer = setTimeout(run, delay)
    }

    const run = async () => {
      if (!alive) return
      const ok = await poll()
      if (!alive) return
      failures = ok ? 0 : Math.min(failures + 1, 10)
      schedule()
    }

    void run()
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, 'opencode-go-quota: poll loop')

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
          // 悬停卡上的手动刷新走这里，避免为了一个按钮再开一条路由。
          // 成功也要复位退避，否则用户手动刷新成功了，下一次计划轮询还在退避里。
          if (req.url && req.url.includes('refresh=1')) {
            if (await poll()) failures = 0
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(
            JSON.stringify({
              ...snapshot,
              thresholds: { warn: cfg.warnPercent, critical: cfg.criticalPercent },
              apiKeyRef: cfg.apiKeyRef,
            }),
          )
        },
      }),
    'opencode-go-quota: state route',
  )
}

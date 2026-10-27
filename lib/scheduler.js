/**
 * 单个额度源的轮询调度。
 *
 * 三条规则从 0.1.x 原样继承——它们都是踩过坑之后写下的，不要顺手「简化」：
 *
 *  1. **失败不清空已拿到的数据**，只把 stale 置 true。否则上游抖一下，界面就从
 *     「45%」变成「—」，而且状态行会谎称「刚刚刷新」。
 *  2. **连续失败按 2 的幂退避**，上限 maxBackoffSec。401 / 403 这类确定性错误
 *     每 5 分钟重试一次没有意义。
 *  3. **手上一条数据都没有、且失败是暂时性时，间隔封顶 60 秒**。退避是为了不打扰上游，
 *     但界面此刻完全空白，让用户对着「—」等 10 分钟并不合理。
 *
 * 每个 provider 各持一个实例，所以故障天然隔离：一家挂了不影响另一家的节奏与数据。
 */
import { CredentialError } from './errors.js'

/** 一个数字都没拿到时的重试上限（毫秒）。 */
const EMPTY_RETRY_MS = 60 * 1000

/** 暂时性失败——值得按紧凑节奏重试；确定性失败不在此列。 */
function isTransient(state) {
  return state === 'pending' || state === 'network' || state === 'rate-limited' || state.startsWith('http-5')
}

/**
 * 造一个调度器。
 *
 * @param options.runPoll - `() => Promise<{windows, balance?, meta?}>`，失败时应抛 ProviderError。
 * @param options.intervalMs - 常规轮询间隔。
 * @param options.maxBackoffMs - 退避上限。
 * @returns 调度器：getSnapshot / hasData / attempt / forceRefresh / start。
 */
export function createScheduler({ runPoll, intervalMs, maxBackoffMs }) {
  /**
   * 最近一次快照。`windows` / `balance` / `fetchedAt` 只记录**最后一次成功**；
   * 失败只翻新 `state` / `error` / `lastAttemptAt` / `stale`。
   */
  let snapshot = {
    ok: false,
    state: 'pending',
    windows: null,
    balance: [],
    meta: null,
    fetchedAt: null,
    lastAttemptAt: null,
    stale: false,
    error: null,
  }

  /** 连续失败次数，驱动退避；成功即复位。 */
  let failures = 0

  /** 当前是否已经拿到过数据——决定失败时要不要压紧重试间隔。 */
  const hasData = () => snapshot.windows !== null || snapshot.balance.length > 0

  /**
   * 拉一次。任何失败都只更新快照，绝不抛。
   * @returns 本次是否成功。
   */
  const attempt = async () => {
    snapshot = { ...snapshot, lastAttemptAt: Date.now() }
    try {
      const fresh = await runPoll()
      const now = Date.now()
      // 适配器可以带回一个非 ok 的状态（例如余额耗尽）：数据本身是新鲜的，
      // 只是「健康度」不是 ok。这种仍然刷新 fetchedAt，且不算失败。
      const state = (fresh && fresh.state) || 'ok'
      snapshot = {
        ok: state === 'ok',
        state,
        windows: Array.isArray(fresh && fresh.windows) ? fresh.windows : [],
        balance: Array.isArray(fresh && fresh.balance) ? fresh.balance : [],
        meta: (fresh && fresh.meta) || null,
        fetchedAt: now,
        lastAttemptAt: now,
        stale: false,
        error: (fresh && fresh.error) || null,
      }
      failures = 0
      return true
    } catch (error) {
      // 凭证问题统一归成 no-key：界面上「去配 key」和「上游挂了」是两种处置。
      const state =
        error instanceof CredentialError
          ? 'no-key'
          : (error && error.state) || 'network'
      snapshot = {
        ...snapshot,
        ok: false,
        state,
        stale: hasData(),
        error: String((error && error.message) || error),
      }
      failures = Math.min(failures + 1, 10)
      return false
    }
  }

  /**
   * 挂进 Cordis 生命周期：返回即注册，卸载时清掉定时器。
   * @param ctx - Cordis 上下文（用到 ctx.effect）。
   * @param label - 出现在 effect 名字里的标识，便于排查。
   */
  const start = (ctx, label) =>
    ctx.effect(() => {
      let alive = true
      let timer = null

      const schedule = () => {
        if (!alive) return
        const backoff = Math.min(maxBackoffMs, intervalMs * Math.pow(2, failures))
        const delay = !hasData() && isTransient(snapshot.state) ? Math.min(backoff, EMPTY_RETRY_MS) : backoff
        timer = setTimeout(run, delay)
      }

      const run = async () => {
        if (!alive) return
        await attempt()
        if (!alive) return
        schedule()
      }

      void run()
      return () => {
        alive = false
        if (timer !== null) clearTimeout(timer)
      }
    }, label)

  return {
    getSnapshot: () => snapshot,
    hasData,
    attempt,
    /** 手动刷新：成功后失败计数已在 attempt 内复位，这里不再额外处理。 */
    forceRefresh: () => attempt(),
    start,
  }
}

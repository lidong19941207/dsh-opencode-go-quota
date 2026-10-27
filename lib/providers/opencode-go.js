/**
 * OpenCode Go 适配器。
 *
 * 上游 `/zen/go/v1/usage` 直接给整数百分比，是三种额度形态里最简单的一种：
 * 三个窗口各自「已用百分之几 + 何时重置」，没有绝对值、没有余额，所以正常化
 * 几乎是把字段搬过来。
 */
import { ProviderError } from '../errors.js'

export const id = 'opencode-go'

/** 品牌名，进卡片标题与无障碍文案，不翻译。 */
export const name = 'OpenCode Go'

/** 环内的品牌标识，1–2 字符。 */
export const mark = 'Go'

/**
 * 额度种类。`windows` = 有进度窗口，徽标画空心环 + 进度弧；
 * `balance` = 只有余额，徽标画实心圆底。形状由种类决定、与「有没有数据」无关，
 * 否则「刚启动还没拉到」会被画成另一种形状，读起来像换了家服务。
 */
export const kind = 'windows'

/** 该 provider 的默认配置；可在 cordis.patch.yml 的 providers.opencode-go 下覆盖。 */
export const defaults = {
  /** 上游基址，接口变更时可改。 */
  baseUrl: 'https://opencode.ai',
  /** 凭证 ref，与模型设置里 opencode-go provider 的 key 保持一致。 */
  apiKeyRef: 'OPENCODE_GO_API_KEY',
}

/** 上游额度接口。 */
const UPSTREAM_PATH = '/zen/go/v1/usage'

/** 三个窗口，顺序即卡片里的显示顺序。 */
const WINDOWS = ['rolling', 'weekly', 'monthly']

/** 凭证来自 DSH 凭证服务——也就是模型设置里那把 key。 */
export const credential = (cfg) => ({ from: 'dsh', ref: cfg.apiKeyRef })

/** 凭证缺失时给人看的标识。 */
export const credentialHint = (cfg) => cfg.apiKeyRef

/**
 * 把上游失败响应归一成界面认识的状态码。
 * @param status - HTTP 状态码。
 * @param body - 已解析的响应体，可能为 null。
 */
function stateForStatus(status, body) {
  const type = body && body.error && body.error.type
  if (status === 401) return 'bad-key'
  if (status === 403 || type === 'EntitlementError') return 'no-subscription'
  if (status === 429) return 'rate-limited'
  return 'http-' + status
}

/**
 * 拉一次额度。
 * @param options.cfg - 本 provider 的配置。
 * @param options.key - 已解析好的凭证。
 * @param options.fetchImpl - fetch 实现（测试可替换）。
 * @returns `{ windows: [{ key, percent, resetsAt, status }] }`。
 * @throws ProviderError - 任何失败都带状态码抛出，由调度器写进快照。
 */
export async function poll({ cfg, key, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(cfg.baseUrl + UPSTREAM_PATH, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'user-agent': 'dsh-opencode-go-quota/0.1',
      },
    })
  } catch (error) {
    throw new ProviderError('network', String((error && error.message) || error))
  }

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    throw new ProviderError(
      stateForStatus(response.status, body),
      (body && body.error && body.error.message) || 'HTTP ' + response.status,
    )
  }

  const usage = body && body.usage
  if (!usage || !usage.rolling || !usage.weekly || !usage.monthly) {
    throw new ProviderError('bad-payload', '响应缺少 usage 字段')
  }

  return {
    windows: WINDOWS.map((key) => ({
      key,
      percent: usage[key].percent,
      resetsAt: usage[key].resetsAt,
      status: usage[key].status,
    })),
  }
}

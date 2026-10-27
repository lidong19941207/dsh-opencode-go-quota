/**
 * DeepSeek 官方余额适配器。
 *
 * 这是三种额度形态里最不同的一种：**没有窗口**。上游只回答「账户里还有多少钱」，
 * 所以归一化结果里 `windows` 为空、`balance` 有一项。徽标对这种 provider 不画进度弧，
 * 改画一个实心圆底 + 品牌字，右侧直接显示金额。
 *
 * 接口是公开承诺的：GET /user/balance，Bearer 模型 key。
 * @see https://api-docs.deepseek.com/api/get-user-balance
 */
import { ProviderError } from '../errors.js'

export const id = 'deepseek'

/** 品牌名，进卡片标题与无障碍文案，不翻译。 */
export const name = 'DeepSeek'

/** 环内标识，1–2 字符。 */
export const mark = 'DS'

/** 额度种类：只有余额，没有窗口，徽标画实心圆底。 */
export const kind = 'balance'

/** 默认配置。 */
export const defaults = {
  baseUrl: 'https://api.deepseek.com',
  /** 与模型设置里 deepseek provider 的 key 保持一致。 */
  apiKeyRef: 'DEEPSEEK_API_KEY',
}

const UPSTREAM_PATH = '/user/balance'

/** 凭证来自 DSH 凭证服务。 */
export const credential = (cfg) => ({ from: 'dsh', ref: cfg.apiKeyRef })

/** 凭证缺失时给人看的标识。 */
export const credentialHint = (cfg) => cfg.apiKeyRef

/** 金额必须是十进制串，别把 NaN 渲染成 "$NaN"。 */
function isAmount(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
}

/**
 * 拉一次余额。
 * @param options.cfg - 本 provider 的配置。
 * @param options.key - 已解析好的凭证。
 * @param options.fetchImpl - fetch 实现（测试可替换）。
 * @returns `{ windows: [], balance: [{ kind: 'money', amount, currency }], state?, error? }`。
 * @throws ProviderError - 网络/鉴权/解析失败。
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

  if (response.status === 401) throw new ProviderError('bad-key', 'API key 无效')
  if (response.status === 403) throw new ProviderError('no-subscription', '该 key 无权限读取余额')

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ProviderError('http-' + response.status, 'HTTP ' + response.status)
  }

  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : null
  if (!infos || infos.length === 0) throw new ProviderError('bad-payload', '响应缺少 balance_infos')

  // 一个账户可能同时有 CNY 与 USD 两档；优先美元，否则取第一条可读的。
  const usable = infos.filter((info) => info && isAmount(info.total_balance))
  if (usable.length === 0) throw new ProviderError('bad-payload', 'balance_infos 里没有可读金额')
  const picked = usable.find((info) => info.currency === 'USD') || usable[0]

  const balance = [{ kind: 'money', amount: picked.total_balance, currency: picked.currency || '' }]

  // `is_available` 为 false 表示余额不足以继续调用。数据本身是有效的，
  // 所以照常返回，只是把状态标成 no-balance，界面上会变红并提示。
  if (body.is_available === false) {
    return { windows: [], balance, state: 'no-balance', error: '余额不足' }
  }
  return { windows: [], balance }
}

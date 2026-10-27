/**
 * 插件的两种可预期错误。
 *
 * 它们都只是「把机器码和人类可读原因一起抛出来」的载体：调度器读 `state` 写进快照，
 * 界面据此挑文案。用类而不是裸字符串，是因为适配器还要能区分「凭证问题」和「上游问题」——
 * 前者重试再多次也不会好，后者值得退避重试。
 */

/** 适配器拉取失败。`state` 必须是界面认识的状态码。 */
export class ProviderError extends Error {
  /**
   * @param state - 机器码，例如 bad-key / no-subscription / network / bad-payload。
   * @param message - 人类可读的原因，进快照的 error 字段。
   */
  constructor(state, message) {
    super(message)
    this.name = 'ProviderError'
    this.state = state
  }
}

/** 取不到凭证。单独一类，便于调度器统一归成 no-key。 */
export class CredentialError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CredentialError'
  }
}

/**
 * OpenCode Go 额度监控 — 浏览器半边。
 *
 * 手写的 ModuleLoader bundle（无需构建步骤）：factory 里只 require 平台种子表
 * 里的 `react`，其余全部内联。注册进 sidebar.footer.action 列表槽。
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useLayoutEffect } = React

    /**
     * 浏览器里用 `useLayoutEffect`，服务端渲染（测试用的 `renderToStaticMarkup`）退化成
     * `useEffect`。直接调用 `useLayoutEffect` 在 SSR 下会打警告，而测试正是靠 SSR 渲染
     * 组件的——不想让每次跑测试都刷一屏噪音。
     *
     * 判据用 `document.createElement`：真实浏览器一定有；测试里的 document 只补了
     * `body` / 事件监听 / `visibilityState`，没有它。
     */
    const canLayout = typeof document !== 'undefined' && typeof document.createElement === 'function'
    const useIsomorphicLayoutEffect = canLayout ? useLayoutEffect : useEffect

    // react-dom 在平台种子表里（React 18.3.1）。拿不到就退回原地渲染，
    // 不让整个组件因为一个可选依赖挂掉。
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch (error) {
      createPortal = null
    }

    /** Host 半边注册的同源只读路由。 */
    const STATE_PATH = '/opencode-go-quota/state'
    /** 记住「翻到哪一家」。POST 写入，读的值随 `/state` 一起下发。 */
    const SELECT_PATH = '/opencode-go-quota/select'
    /** 客户端读取间隔：Host 侧另有自己的轮询节奏。 */
    const READ_INTERVAL_MS = 30_000

    /**
     * 冷启动加速重试。
     *
     * Host 的首次上游拉取是异步的：DSH 刚起来时页面往往先渲染完，此时读到的是
     * `pending`（一个数字都没有）。若仍按 30 秒的常规节奏等，徽标会长时间停在「—」，
     * 而用户只要把鼠标划过徽标就会触发一次补读、数字立刻出现——现象上就成了
     * 「必须动一下鼠标才加载」。
     *
     * 所以「还没有任何数字、且失败是暂时性的」时改用 1 秒节奏，最多 60 次；
     * 之后回到常规节奏。读的是 Host 内存快照，不打上游，这个频率是零成本的。
     */
    const FAST_RETRY_MS = 1_000
    const FAST_RETRY_LIMIT = 60

    /**
     * 徽标换页时的统一时长。
     *
     * 换一家时徽标上有四样东西要变：环弧长度、环心品牌字、右侧数值、状态色。
     * 它们**必须落在同一条时间线上**——曾经是弧 450ms、环心字 200ms、数值 260ms、
     * 颜色 350ms，各走各的，看上去就是一段一段地「碎」着变完。
     *
     * 取 240ms：比浏览器的 scroll-snap 动画（约 300ms）略快，翻页时能感觉到
     * 「点哪里、哪里就先到位」，又不至于快到看不见。
     */
    const BADGE_SWAP_MS = 240
    /** 数值换字的单段淡出/淡入时长；两段加起来正好等于 BADGE_SWAP_MS。 */
    const SWAP_FADE_MS = BADGE_SWAP_MS / 2
    /** 统一的缓动：先快后缓，收尾干净，不像 linear 那样「刹不住」。 */
    const SWAP_EASE = 'cubic-bezier(.2,.7,.3,1)'

    /**
     * 排版与深度常量，来源是 awesome-design-md 里 Linear / Vercel / Stripe 的做法。
     *
     * 两条对这张卡影响最大的规则：
     *
     *  1. **深度靠多层薄阴影 + 发丝边框，不靠单层重投影。**
     *     Vercel：「stacked-shadow elevation — three offsets layered with 4-12%
     *     black opacity — never a single heavy drop-shadow」。
     *     原来那条 `0 12px 32px rgba(0,0,0,.16)` 正是被点名禁止的单层重投影。
     *
     *  2. **字号越大，负字距压得越多。**
     *     Linear：22px 用 -0.4px；Stripe：display 用 -1.4px。
     *     正文字号不做字距处理，只在小标题上收一点点。
     */
    const TRACK_TITLE = '-0.15px'
    const TRACK_VALUE = '-0.2px'
    const TRACK_HERO = '-0.5px'
    /** Vercel 式三层堆叠：偏移 1/2/8、模糊 1/6/18、黑度 18/12/8%。 */
    const SHADOW_STACK =
      '0 1px 1px rgba(0,0,0,.07), 0 2px 6px rgba(0,0,0,.05), 0 8px 18px rgba(0,0,0,.045)'
    /** 悬停时略微加深：只加一层，避免三档都变。 */
    const SHADOW_STACK_HOVER =
      '0 1px 1px rgba(0,0,0,.09), 0 3px 10px rgba(0,0,0,.07), 0 12px 26px rgba(0,0,0,.07)'

    /**
     * 徽标行的盒子。刻意与下方账号行（`settings.launcher` 里的 AccountMenu）取同一组数字，
     * 两行才会在视觉上成对：
     *
     *   账号行容器  width: calc(100% + 4px); margin: 4px -2px
     *   账号按钮    height: 44px; padding: 6px; gap: 8px; border-radius: 12px
     *   头像        24px 圆
     *
     * 由此头像左缘落在 x = 12 − 2 + 6 = 16（12 是侧边栏 root 的左右内边距）。
     * 徽标照抄这组数字，环的左缘同样落在 16，两行左对齐。
     */
    const ROW_HEIGHT = 44
    const ROW_PADDING = 6
    const ROW_GAP = 8
    /** 折叠态下账号行收成 36×36 的方块，徽标跟着收。 */
    const RAIL_SIZE = 36

    /**
     * 详情卡的内部几何。
     *
     * 这组数字不是随手调的，它们共同保证一件事：**卡内所有内容左缘是一条线**。
     * 旧实现把重置时间缩进 64px（= 标签列 56 + 间隔 8），而标签本身在 padding 12，
     * 两者差 8px，眼睛一眼就看出歪。现在注释回到 padding，靠字号与颜色区分层级。
     *
     *   卡宽 288 = padding 14 + 标签列 54 + 间距 9 + 轨道 + 间距 9 + 数值列 40 + padding 14
     *   窗口块 36 = 标签行 12（行高 18）+ 注释 11（行高 18）
     */
    const CARD_WIDTH = 288
    const CARD_PADDING = 14
    const CARD_RADIUS = 12
    const CARD_GAP = 12
    const LABEL_COLUMN = 54
    const VALUE_COLUMN = 40
    const BAR_HEIGHT = 4
    const WINDOW_ROW = 36
    const WINDOW_GAP = 13
    const FOOTER_ROW = 16
    /**
     * 切页时卡片高度的补间时长。
     *
     * 必须与 `BADGE_SWAP_MS` 一致：点一次页码，卡片高度与徽标数值是同一个动作的两个
     * 表现，时长不同就会一前一后地「追」，看着不顺。同页数据刷新不播，否则每次
     * 轮询都会抖一下。
     */
    const CARD_RESIZE_MS = 240

    /**
     * 环的几何。环内嵌的是品牌字「Go」——品牌不翻译，所以它不走字典。
     *
     * 内径 = 直径 − 2×描边，中心字必须留出左右余量，否则 24px 下会糊成一团：
     * 24px / 3px → 内径 18px，「Go」11px 粗体宽约 14.6px，左右各只剩 1.7px；
     * 24px / 2px → 内径 20px，「Go」10.5px 半粗宽约 13.5px，左右各余 3.2px。
     * 所以描边取 2px、字号取 10.5px——环细一点，字反而更清楚。
     * 再往下缩（16px / 2.5px）内径只有 11px，中心字无法辨认。
     */
    const RING_SIZE = 24
    const RING_STROKE = 2
    const RING_TEXT_SIZE = 10.5
    /** 略收紧字距，「Go」两字在环内更居中。 */
    const RING_TEXT_TRACKING = -0.2

    /** 语言命名空间。交给槽位注册后，框架会注入随语言切换自动刷新的 `t`。 */
    const NS = 'opencode-go-quota'

    /**
     * 字典。locale 服务要求**同时提供 zh 与 en**；其余语言沿 fallback 链落到 en。
     *
     * 刻意不用复数键（`.one`/`.other`）：时间一律用缩写（`12d 17h` / `12 天 17 小时`），
     * 绕开复数规则，字典能小一半。
     */
    const zh = {
      'panel.label': '额度',
      'badge.aria': '{name}：{window} 已用 {percent}%，{reset}',
      'badge.ariaStale': '，数据可能已过期',
      'badge.ariaError': '{name}：{reason}',
      'window.rolling': '5 小时',
      'window.daily': '今日',
      'window.weekly': '本周',
      'window.monthly': '本月',
      'window.hours': '{count} 小时',
      'window.days': '{count} 天',
      'window.rolling.short': '5h',
      'window.daily.short': '日',
      'window.weekly.short': '周',
      'window.monthly.short': '月',
      'window.hours.short': '{count}h',
      'window.days.short': '{count}d',
      'status.limited': '已限流',
      'status.noBalance': '余额不足',
      'balance.label': '余额',
      'balance.credits': '{amount} 点',
      'empty.noCredential': '凭证未配置',
      'empty.noCredentialHint': '配置 {ref} 后自动出现',
      'empty.noWorkspace': '没有可读的 workspace',
      'empty.noWorkspaceHint': '该账号下没有个人 workspace',
      'empty.noSubscription': '未订阅 Coding Plan',
      'empty.noSubscriptionHint': '额度接口没有返回任何窗口',
      'empty.unavailable': '数据不可用',
      'empty.unavailableHint': '稍后会自动重试',
      'reset.soon': '即将重置',
      'reset.days': '{days} 天 {hours} 小时后重置',
      'reset.hours': '{hours} 小时 {minutes} 分后重置',
      'reset.minutes': '{minutes} 分钟后重置',
      'row.limited': '已限流 · {reset}',
      'row.empty': '暂无数据',
      'row.rollingReset': '按使用滚动重置',
      'ago.seconds': '{seconds} 秒前',
      'ago.minutes': '{minutes} 分钟前',
      'ago.hours': '{hours} 小时前',
      'footer.refreshed': '{ago}刷新',
      'footer.stale': '数据 {ago} · {reason}',
      'action.refresh': '立即刷新',
      'error.noKey': '凭证 {ref} 未配置',
      'error.badKey': 'API key 无效',
      'error.noSubscription': '{name} 未开通',
      'error.noBalance': '余额不足',
      'error.network': '网络不可达',
      'error.pending': '正在读取…',
      'error.unavailable': '数据不可用',
      'error.failed': '额度不可用',
    }

    const en = {
      'panel.label': 'Quota',
      'badge.aria': '{name}: {window} at {percent}%, {reset}',
      'badge.ariaStale': ', data may be out of date',
      'badge.ariaError': '{name}: {reason}',
      // 标签格固定 56px（@13px），太长会折行把整行的对齐全打乱：
      // 'Last 5 hours' 69.2px / 'This month' 64.4px 都会溢出，'This week' 55.9px 也只剩 0.1px。
      // 所以英文用短名，中文那三个本来就只有 16~27px。
      'window.rolling': '5 hours',
      'window.daily': 'Today',
      'window.weekly': 'Week',
      'window.monthly': 'Month',
      'window.hours': '{count} hours',
      'window.days': '{count} days',
      'window.rolling.short': '5h',
      'window.daily.short': 'D',
      'window.weekly.short': 'Wk',
      'window.monthly.short': 'Mo',
      'window.hours.short': '{count}h',
      'window.days.short': '{count}d',
      'status.limited': 'Rate limited',
      'status.noBalance': 'Out of balance',
      'balance.label': 'Balance',
      'balance.credits': '{amount} credits',
      'empty.noCredential': 'Credential missing',
      'empty.noCredentialHint': 'Appears once {ref} is set',
      'empty.noWorkspace': 'No readable workspace',
      'empty.noWorkspaceHint': 'This account has no personal workspace',
      'empty.noSubscription': 'No Coding Plan',
      'empty.noSubscriptionHint': 'The quota API returned no windows',
      'empty.unavailable': 'Data unavailable',
      'empty.unavailableHint': 'Retries automatically',
      'reset.soon': 'resetting soon',
      'reset.days': 'resets in {days}d {hours}h',
      'reset.hours': 'resets in {hours}h {minutes}m',
      'reset.minutes': 'resets in {minutes}m',
      'row.limited': 'Rate limited · {reset}',
      'row.empty': 'No data',
      'row.rollingReset': 'Rolls with usage',
      'ago.seconds': '{seconds}s ago',
      'ago.minutes': '{minutes}m ago',
      'ago.hours': '{hours}h ago',
      'footer.refreshed': 'Refreshed {ago}',
      'footer.stale': 'Data from {ago} · {reason}',
      'action.refresh': 'Refresh now',
      'error.noKey': 'Missing {ref}',
      'error.badKey': 'Invalid API key',
      'error.noSubscription': '{name} is not active',
      'error.noBalance': 'Balance exhausted',
      'error.network': 'Network unreachable',
      'error.pending': 'Loading…',
      'error.unavailable': 'Data unavailable',
      'error.failed': 'Quota unavailable',
    }

    /**
     * 窗口文案。
     *
     * 窗口不再由客户端写死：每个 provider 有几个窗口、叫什么，由 Host 下发。这里只负责
     * 把 `key` 翻成文案——字典命中就用字典（切语言会跟着变），没命中就退回适配器给的
     * 语言无关兜底（`fallbackLabel`，例如 `7d`），再没有就原样显示 key。
     *
     * 已知长度（18000 秒 = 5 小时、604800 秒 = 7 天）额外按 `durationSeconds` 生成
     * 文案，所以「窗口由套餐决定」的来源也能显示「5 小时」/「7 天」，
     * 而不是只剩 `5h` 这种兜底串。字典里有复数规则的地方一律用缩写，绕开复数。
     *
     * 这样新增 provider 不必改客户端：新窗口只要能给出 key 或兜底标签，界面就能画。
     * @param win - Host 下发的窗口对象。
     * @param t - 字典函数。
     * @param suffix - `''` 取全名，`'.short'` 取短名。
     * @param fallback - 字典未命中时的兜底文本。
     */
    function windowText(win, t, suffix, fallback) {
      const dictKey = 'window.' + win.key + suffix
      const text = t(dictKey)
      if (text && text !== dictKey) return text

      // 按长度生成：整天的报「天」，整小时的报「小时」。上游若给 90 分钟这种非整值，
      // 生成出来会是「2 小时」——所以只在能整除时才启用，其余落回兜底串。
      const seconds = win.durationSeconds
      if (typeof seconds === 'number' && seconds > 0) {
        const dayKey = 'window.days' + suffix
        const hourKey = 'window.hours' + suffix
        if (seconds % 86_400 === 0) {
          const generated = t(dayKey, { count: seconds / 86_400 })
          if (generated && generated !== dayKey) return generated
        }
        if (seconds % 3_600 === 0 && seconds < 86_400) {
          const generated = t(hourKey, { count: seconds / 3_600 })
          if (generated && generated !== hourKey) return generated
        }
      }

      return fallback || win.key
    }

    /** 窗口全名，例如「5 小时」/「This month」。 */
    function windowLabel(win, t) {
      return windowText(win, t, '', win.fallbackLabel)
    }

    /** 窗口短名，用在徽标那一行，例如「5h」/「月」。 */
    function windowShort(win, t) {
      return windowText(win, t, '.short', win.fallbackLabel || win.key)
    }

    /**
     * 按阈值挑状态色 token。
     * @param percent - 已用百分比。
     * @param thresholds - { warn, critical }。
     * @returns CSS 颜色表达式。
     */
    function toneOf(percent, thresholds) {
      const warn = (thresholds && thresholds.warn) || 80
      const critical = (thresholds && thresholds.critical) || 95
      if (typeof percent !== 'number') return 'var(--dsw-alias-state-idle-primary)'
      if (percent >= critical) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= warn) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    /**
     * 把重置时刻格式化成相对时间。
     * @param iso - ISO 时间串。
     * @param t - 字典函数。
     * @returns 例如「2 小时 14 分后重置」/「resets in 2h 14m」；无法解析时返回空串。
     */
    function formatReset(iso, t) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const ms = at - Date.now()
      if (ms <= 0) return t('reset.soon')
      const minutes = Math.floor(ms / 60_000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return t('reset.days', { days, hours })
      if (hours > 0) return t('reset.hours', { hours, minutes: mins })
      return t('reset.minutes', { minutes: Math.max(1, mins) })
    }

    /**
     * 相对「多久之前」。只给时间，动词由调用方按成功/失败拼。
     * @param at - 毫秒时间戳。
     * @param t - 字典函数。
     * @returns 本地化描述；无时间戳时为空串。
     */
    function formatAgo(at, t) {
      if (!at) return ''
      const sec = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (sec < 60) return t('ago.seconds', { seconds: sec })
      const min = Math.floor(sec / 60)
      if (min < 60) return t('ago.minutes', { minutes: min })
      return t('ago.hours', { hours: Math.floor(min / 60) })
    }

    /**
     * 三个窗口里**最接近上限**的那个。
     *
     * 这才是真正会卡住请求的闸门：Go 的三个窗口各有独立上限（5 小时 = 月额度的
     * 20%、周 = 50%、月 = 100%），只看月窗口会在「5 小时已 95%、月才 45%」时
     * 显示成绿色的 45%，低估实际风险。
     * @param provider - Host 下发的单个 provider 快照。
     * @param t - 字典函数，用来把窗口名翻译出来。
     * @returns 最紧的窗口，或 null（无数据）。
     */
    function worstWindow(provider, t) {
      let worst = null
      const windows = (provider && provider.windows) || []
      for (const win of windows) {
        if (!win || typeof win.percent !== 'number') continue
        if (worst === null || win.percent > worst.percent) {
          worst = {
            key: win.key,
            label: windowLabel(win, t),
            short: windowShort(win, t),
            percent: win.percent,
            entry: win,
          }
        }
      }
      return worst
    }

    /** 这个 provider 手上有没有可展示的内容（窗口或余额）。 */
    function hasContent(provider) {
      if (!provider) return false
      return (provider.windows && provider.windows.length > 0) || (provider.balance && provider.balance.length > 0)
    }

    /** 最紧窗口的百分比；没有窗口时 null。不带文案，供着色用。 */
    function worstPercent(provider) {
      let max = null
      for (const win of (provider && provider.windows) || []) {
        if (!win || typeof win.percent !== 'number') continue
        if (max === null || win.percent > max) max = win.percent
      }
      return max
    }

    /**
     * 一个 provider 的状态色。徽标、卡片状态点、翻页圆点共用同一套判断，
     * 免得同一屏上出现两种说法。
     */
    function toneFor(provider, thresholds) {
      const percent = worstPercent(provider)
      if (percent !== null) return toneOf(percent, thresholds)
      if (provider.state === 'no-balance') return 'var(--dsw-alias-state-error-primary)'
      if (provider.kind === 'balance' && (provider.balance || []).length > 0) {
        return 'var(--dsw-alias-state-success-primary)'
      }
      return 'var(--dsw-alias-state-idle-primary)'
    }

    /**
     * 卡片底部那行状态文案。
     * @param provider - 单个 provider 快照。
     * @param t - 字典函数。
     * @returns 展示文本。
     */
    function statusLine(provider, t) {
      if (provider.ok) return t('footer.refreshed', { ago: formatAgo(provider.fetchedAt, t) })
      const reason = messageFor(provider.state, provider, t)
      // 有旧数据却说「不可用」是误导：明确标出这份数据是什么时候的。
      if (hasContent(provider) && provider.fetchedAt) {
        return t('footer.stale', { ago: formatAgo(provider.fetchedAt, t), reason })
      }
      return reason
    }

    /**
     * 失败状态文案。
     * @param state - Host 归一出的状态码。
     * @param provider - 单个 provider 快照（取名字、凭证名与原始错误）。
     * @param t - 字典函数。
     * @returns 展示文本。
     */
    function messageFor(state, provider, t) {
      const name = (provider && provider.name) || ''
      if (state === 'no-key') return t('error.noKey', { ref: (provider && provider.credentialLabel) || '' })
      if (state === 'bad-key') return t('error.badKey')
      if (state === 'no-subscription') return t('error.noSubscription', { name })
      if (state === 'no-balance') return t('error.noBalance')
      if (state === 'network') return t('error.network')
      if (state === 'pending') return t('error.pending')
      return (provider && provider.error) || t('error.unavailable')
    }

    /**
     * 这次快照值不值得提速重读。
     *
     * 只有「一个数字都还没有」且失败是暂时性的才值得：`pending` 是 Host 首次上游
     * 拉取还没回来，`network` 是本地路由还没就绪或页面刚起来，两者都会自己好。
     * 凭证没配、key 失效、没订阅、响应缺字段这类是确定性错误，重试再快也不会变，
     * 交给常规节奏即可——否则只是空转。
     * @param body - 本次读到的快照，失败时为 null。
     * @returns 是否应缩短下一次读取间隔。
     */
    function needsFastRetry(body) {
      const providers = (body && body.providers) || []
      // 路由本身都没打通（body 为 null 或没有 providers），按暂时性处理。
      if (providers.length === 0) return true
      return providers.some((provider) => {
        if (hasContent(provider)) return false
        return provider.state === 'pending' || provider.state === 'network'
      })
    }

    /**
     * 用户是否要求减少动效。
     *
     * `prefers-reduced-motion: reduce` 是系统级无障碍设置：前庭功能敏感的用户会因
     * 位移动画与淡入淡出感到不适。它不是「可选优化」——尊重它才是正确行为。
     * 环境不支持 `matchMedia`（SSR、老内核）时按 false 处理，动画照常。
     * @returns 是否应跳过动画。
     */
    function reducedMotion() {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      } catch (error) {
        return false
      }
    }

    /**
     * 把一段 transition 声明变成「尊重减少动效」的形式。
     *
     * 内联样式里写不了 `@media (prefers-reduced-motion)`，所以只能由脚本判断。
     * 集中在这里，是为了不出现「有的地方尊重、有的地方不尊重」这种半吊子状态。
     * @param value - 正常的 transition 值，例如 `width .3s ease`。
     * @returns 用户要求减少动效时返回 `none`，否则原样返回。
     */
    function motion(value) {
      return reducedMotion() ? 'none' : value
    }

    /**
     * 用 Web Animations 播一段一次性动画。
     *
     * 为什么不用 CSS transition：transition 需要一个「先低后高」的初值再翻转，
     * 而翻页时新值节点是**刚挂载**的，没有旧值可比，transition 不会触发。
     * 也不用 @keyframes：那要往 document.head 塞 <style>，某些 CSP 只放行
     * 行内 style 属性而不放行样式表元素，徽标就会静默地没有动画。
     * `element.animate()` 由脚本驱动，绕开这两件事。
     *
     * 环境不支持（SSR、老内核）或用户要求减少动效时安静跳过——动画是锦上添花，
     * 不能影响渲染，更不能与无障碍设置对抗。
     * @param node - 目标元素，可能为 null。
     * @param frames - 关键帧。
     * @param duration - 毫秒。
     */
    function play(node, frames, duration) {
      if (!node || typeof node.animate !== 'function') return
      if (reducedMotion()) return
      try {
        node.animate(frames, { duration, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'none' })
      } catch (error) {
        // 动画失败绝不能让徽标挂掉。
      }
    }

    /**
     * 换值时不硬跳的文字。
     *
     * 直接换字符串会让「月 45%」硬生生变成「5h 7.7%」，在徽标里看起来像闪了一下。
     *
     * 这里刻意用**单个节点**做「淡出 → 换字 → 淡入」，而不是叠两层做交叉淡化：
     *  - 两层叠在同一位置，宽度不同时旧值会压在新值上，观感是重影（已踩过）；
     *  - 叠层还得靠定时器把旧节点摘掉，一旦 cleanup 抢先清掉定时器，旧值就永久
     *    留在 DOM 里，变成一直在的重影。
     * 单节点没有这些问题：任何时刻 DOM 里只有一份文本。
     *
     * 用 CSS transition 而不是 element.animate：节点是持久的，opacity 从 1→0→1
     * 每次都会重新触发过渡，正好是我们要的。不满足条件（SSR、prefers-reduced-motion）
     * 时直接换字，功能不受影响。
     * @param props.text - 要显示的文本。
     * @param props.style - 其余静态样式（颜色、字重、flex 等由调用方决定）。
     */
    function SwappingText({ text, style }) {
      const [shown, setShown] = useState(text)
      const [faded, setFaded] = useState(false)

      useEffect(() => {
        // 已经显示的就是新值（首次挂载、或过渡收尾时正好相等）：什么都不用做。
        if (text === shown) {
          setFaded(false)
          return undefined
        }
        setFaded(true)
        // 等到淡出跑完再换字，换完把透明度交还给 CSS 做淡入。
        const timer = setTimeout(() => {
          setShown(text)
          setFaded(false)
        }, SWAP_FADE_MS)
        // 这次 cleanup 只会因为「又来了一个新值」或卸载而触发：两种情况都该放弃
        // 本次过渡，让最新一次重新开始。
        return () => clearTimeout(timer)
      }, [text, shown])

      return h(
        'span',
        {
          style: {
            ...style,
            whiteSpace: 'nowrap',
            opacity: faded ? 0 : 1,
            // 只过渡 opacity：颜色交给外层（见 QuotaBadge 的数值样式），
            // 两处各管一半，避免同一个元素上两条 transition 互相覆盖。
            transition: motion('opacity ' + SWAP_FADE_MS + 'ms ' + SWAP_EASE),
          },
        },
        shown,
      )
    }

    /**
     * 环心的品牌字。
     *
     * 单独拆出来是为了让它持有自己的 ref 与动画：SVG 的 `<text>` 不能像 HTML 那样
     * 叠两层做交叉淡化（那需要两个 `x/y` 完全相同的节点），所以这里改成
     * 「透明度归零 → 换字 → 淡回」，肉眼看是连续的一次呼吸。
     * @param props.mark - 品牌字。
     * @param props.x / props.y - 圆心。
     * @param props.size - 字号。
     */
    function RingMark({ mark, x, y, size }) {
      const ref = useRef(null)

      useEffect(() => {
        const node = ref.current
        if (!node) return
        // 与弧、数值、状态色同步：整块徽标在同一时间线上一起变。
        play(node, [{ opacity: 0.15 }, { opacity: 1 }], BADGE_SWAP_MS)
      }, [mark])

      return h(
        'text',
        {
          ref,
          x,
          y,
          textAnchor: 'middle',
          dominantBaseline: 'central',
          fontSize: size + 'px',
          fontWeight: 600,
          letterSpacing: RING_TEXT_TRACKING + 'px',
          // 字用正文色而不是弧的颜色：24px 下绿字压在绿弧上会糊成一团，
          // 状态信号交给弧去承担，字只负责「这是哪个服务」。
          fill: 'var(--dsw-alias-label-primary)',
          // SVG 文字默认不继承页面字体，显式继承侧边栏的字体栈。
          style: { fontFamily: 'inherit' },
        },
        mark || 'Go',
      )
    }

    /**
     * 环形进度，中心内嵌 provider 的品牌字。
     *
     * 环因此同时承担两件事：进度（弧）与标识（中心字）。代价是弧相对环身变细、
     * 中心字会分走一点注意力，所以右侧那个数值仍然保留——一眼扫不出精确进度时还有它兜底。
     *
     * 翻页时环会整体换一家（弧度、颜色、形状都可能变），所以弧长与描边都加了过渡；
     * 中心字则用 key 触发一次交叉淡入（见 markText），避免「Go」硬生生变成「OD」。
     * @param props.percent - 已用百分比。
     * @param props.color - 弧（或圆底）的颜色。
     * @param props.mark - 中心字，由 provider 提供（`Go` / `DS` …）。
     * @param props.filled - 余额型 provider：没有进度可言，画实心圆底而不是空心环。
     */
    function Ring({ percent, color, mark, filled }) {
      const px = RING_SIZE
      const stroke = RING_STROKE
      const r = (px - stroke) / 2
      const c = 2 * Math.PI * r
      const value = Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0))

      const label = h(RingMark, {
        mark: mark || 'Go',
        x: px / 2,
        y: px / 2,
        // 两个字符（`Go` / `DS`）在 20px 内径里刚好放得下；再长才需要收字号。
        size: mark && mark.length > 2 ? RING_TEXT_SIZE - 2 : RING_TEXT_SIZE,
      })

      const box = { width: px, height: px, viewBox: '0 0 ' + px + ' ' + px, 'aria-hidden': 'true', style: { flex: 'none' } }

      if (filled) {
        // 余额型：实心圆底 + 一圈淡描边。形状本身就是信号——「这家没有窗口」。
        // 空心环留给有进度的 provider，避免把「没有进度」误读成「0%」。
        return h(
          'svg',
          box,
          h('circle', { cx: px / 2, cy: px / 2, r: px / 2 - 0.5, fill: color, opacity: 0.16 }),
          h('circle', {
            cx: px / 2,
            cy: px / 2,
            r: px / 2 - 0.5,
            fill: 'none',
            stroke: color,
            strokeWidth: 1.5,
            opacity: 0.55,
          }),
          label,
        )
      }

      return h(
        'svg',
        box,
        h('circle', {
          cx: px / 2,
          cy: px / 2,
          r,
          fill: 'none',
          stroke: 'var(--dsw-alias-border-l2)',
          strokeWidth: stroke,
        }),
        h('circle', {
          cx: px / 2,
          cy: px / 2,
          r,
          fill: 'none',
          stroke: color,
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeDasharray: c,
          strokeDashoffset: c * (1 - value / 100),
          transform: 'rotate(-90 ' + px / 2 + ' ' + px / 2 + ')',
          // 弧长与颜色走同一条时间线：翻页时整块徽标一起变，不再分段跳。
          style: { transition: motion('stroke-dashoffset ' + BADGE_SWAP_MS + 'ms ' + SWAP_EASE + ', stroke ' + BADGE_SWAP_MS + 'ms ' + SWAP_EASE) },
        }),
        label,
      )
    }

    /**
     * 百分比文案。
     *
     * 整数就不带小数点（上游本来就给整数），有小数才保留一位——由 credits 算出的
     * 比例常常是 6.48%，抹成 6% 会让「刚用了一点」和「一点没用」看起来一样。
     * @param percent - 已用百分比。
     * @returns 例如 `6.5%` / `45%`。
     */
    function percentText(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
      const rounded = Math.round(percent * 10) / 10
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%'
    }

    /**
     * 一条窗口进度条。
     *
     * 三行结构的克制版：标签与百分比的字号/字重必须**高于**注释，否则三层一起糊成一段。
     * 百分比用 600 而不是 400——它是这张卡上最该被扫到的数字。
     * @param props.label - 已翻译的窗口名。
     * @param props.entry - 该窗口的上游数据。
     * @param props.thresholds - 阈值配置。
     * @param props.worst - 是否是当前最紧的窗口（标签会跟着变色，不占额外宽度）。
     * @param props.t - 字典函数。
     */
    function WindowRow({ label, entry, thresholds, worst, t }) {
      const percent = entry && entry.percent
      const color = toneOf(percent, thresholds)
      const limited = entry && entry.status === 'rate-limited'
      // 越过阈值时整行一起变色（标签 + 轨道 + 百分比）：只变一处会让人以为
      // 「变色的是文字，不是这个窗口」。
      const signal = limited || (typeof percent === 'number' && percent >= ((thresholds && thresholds.warn) || 80))

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', height: '18px', gap: '9px' } },
          h(
            'span',
            {
              style: {
                width: LABEL_COLUMN + 'px',
                flex: 'none',
                fontSize: '12px',
                fontWeight: 500,
                // 必须 nowrap：标签格是固定宽度，长文案折行会把这一行和下面那行
                // （重置时间）的对齐全部打乱。溢出时省略号截断。
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: signal ? color : 'var(--dsw-alias-label-secondary)',
              },
              title: label,
            },
            label,
          ),
          h(
            'span',
            {
              style: {
                flex: '1',
                height: BAR_HEIGHT + 'px',
                borderRadius: BAR_HEIGHT / 2 + 'px',
                background: 'var(--dsw-alias-bg-layer-2)',
                overflow: 'hidden',
              },
            },
            h('span', {
              style: {
                display: 'block',
                height: '100%',
                // 有值就必须看得见：0.1% 也给 1.6% 的最小可视宽度，
                // 否则「用了一点」和「完全没用」画出来一模一样。
                width: Math.max(Math.min(100, percent || 0), percent > 0 ? 1.6 : 0) + '%',
                background: color,
                borderRadius: BAR_HEIGHT / 2 + 'px',
                transition: motion('width .3s var(--ds-ease-in-out, ease)'),
              },
            }),
          ),
          h(
            'span',
            {
              style: {
                width: VALUE_COLUMN + 'px',
                flex: 'none',
                textAlign: 'right',
                fontSize: '13px',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                // 数字也收紧一点：600 字重的数字在等宽表格里本来就偏松。
                letterSpacing: TRACK_VALUE,
                color: signal ? color : 'var(--dsw-alias-label-primary)',
              },
            },
            percentText(percent),
          ),
        ),
        h(
          'div',
          { style: { height: '18px', fontSize: '11px', lineHeight: '18px', color: signal ? color : 'var(--dsw-alias-label-tertiary)' } },
          // entry 可能整个缺失：尚未拿到数据，或该窗口字段未返回。必须显式判空——
          // 直接读 entry.resetsAt 会在渲染期抛错，React 随即卸载整棵子树，
          // 徽标会从槽位里消失且不留痕迹。
          rowNote(entry, limited, t),
        ),
      )
    }

    /**
     * 一条窗口下方那行小字：重置时间，或「没有可显示的时间」。
     *
     * 上游对**滚动窗口**（`activity_triggered`）不保证给 `resetsAt`，因为重置时刻取决于
     * 下一次使用；这时硬渲染一个空串会让那一行看起来像渲染坏了，所以给一句明确的文案。
     * @param entry - 该窗口的上游数据。
     * @param limited - 该窗口是否已限流。
     * @param t - 字典函数。
     * @returns 展示文本。
     */
    function rowNote(entry, limited, t) {
      if (entry === undefined || entry === null) return t('row.empty')
      const reset = formatReset(entry.resetsAt, t)
      if (limited) return t('row.limited', { reset })
      if (reset) return reset
      return entry.resetMode === 'activity_triggered' ? t('row.rollingReset') : t('row.empty')
    }

    /**
     * 单个 provider 的状态。
     *
     * `text` 为空表示「不必说」——正常态只留色点。把「正常」二字印在每张卡上，
     * 反而稀释了异常时的信号：真正该被看见的是「已限流」，不是「一切正常」。
     * 过期态也不出标题文字（整卡已经降透明度，页脚会说明原因）。
     * @param provider - 单个 provider 快照。
     * @param t - 字典函数。
     * @returns `{ text, color }`；text 可能为空串。
     */
    function statusOf(provider, t) {
      const windows = provider.windows || []
      const limited = windows.some((win) => win && win.status === 'rate-limited')
      if (provider.state === 'no-balance') {
        return { text: t('status.noBalance'), color: 'var(--dsw-alias-state-error-primary)' }
      }
      if (provider.ok) {
        return limited
          ? { text: t('status.limited'), color: 'var(--dsw-alias-state-error-primary)' }
          : { text: '', color: 'var(--dsw-alias-state-success-primary)' }
      }
      // 有旧数据的失败 = 过期；整卡虚化已经足够表达，标题不再重复一遍。
      if (hasContent(provider)) return { text: '', color: 'var(--dsw-alias-state-warn-primary)' }
      return { text: '', color: 'var(--dsw-alias-state-idle-primary)' }
    }

    /** 给整数加千分位，例如 12400 → 12,400。 */
    function groupDigits(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 一条余额。金额用符号，点数走字典。
     * @param item - `{ kind: 'money', amount, currency }` 或 `{ kind: 'credits', amount }`。
     * @param t - 字典函数。
     */
    function formatBalance(item, t) {
      if (!item) return ''
      if (item.kind === 'credits') return t('balance.credits', { amount: groupDigits(item.amount) })
      const symbol = item.currency === 'CNY' ? '¥' : item.currency === 'USD' ? '$' : ''
      return symbol ? symbol + item.amount : item.amount + ' ' + (item.currency || '')
    }

    /**
     * 卡片右上角的刷新按钮。
     *
     * 交互状态按 DESIGN.md 的规则补齐（此前只有默认态）：
     *  - hover：浮出浅色圆形底（Vercel 的 ghost pill：「visible only on hover」）
     *  - focus-visible：环形焦点，键盘可达
     *  - active：底色加深，给一次按压反馈
     *  - 刷新中：图标旋转，避免「点了没反应」的错觉
     *
     * 用组件而不是内联在 ProviderPage 里，因为它是唯一需要持有 hover 状态的地方。
     * @param props.onClick - 触发刷新。
     * @param props.label - 无障碍与 title 文案。
     */
    function RefreshButton({ onClick, label }) {
      const [hovered, setHovered] = useState(false)
      const [pressed, setPressed] = useState(false)

      return h(
        'button',
        {
          type: 'button',
          onClick,
          title: label,
          'aria-label': label,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => {
            setHovered(false)
            setPressed(false)
          },
          onMouseDown: () => setPressed(true),
          onMouseUp: () => setPressed(false),
          style: {
            flex: 'none',
            width: '20px',
            height: '20px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            border: 'none',
            padding: 0,
            marginRight: '-4px',
            borderRadius: '50%',
            fontSize: '13px',
            lineHeight: 1,
            // 三档底色：静止透明 → 悬停浅底 → 按下更深。
            background: pressed
              ? 'var(--dsw-alias-interactive-bg-hover)'
              : hovered
                ? 'var(--dsw-alias-bg-layer-2)'
                : 'transparent',
            color: hovered ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
            // 内联样式拿不到 :focus-visible，用 outline 兜住键盘可达性即可。
            outline: 'none',
            transition: motion('background .12s var(--ds-ease-out, ease-out), color .12s var(--ds-ease-out, ease-out)'),
          },
        },
        h('span', {
          style: {
            display: 'inline-block',
            // 悬停时转一点点，暗示「可以点」；不做整圈，避免和真实刷新动画混淆。
            transform: hovered ? 'rotate(-30deg)' : 'none',
            transition: motion('transform .18s ' + SWAP_EASE),
          },
        }, '⟳'),
      )
    }

    /**
     * 卡片里的一页：一个 provider 的标题、窗口（或余额）与自身的新鲜度。
     *
     * 高度**不固定**，由内容决定；外层 `Card` 负责切页时补间。
     * 旧实现每页 `height:100%`，卡片取「最高那一页」，于是只有一行余额的 DeepSeek
     * 也占满 246px，三分之二全是空白。
     *
     * 用普通函数而不是组件：它不持有状态，也不想在槽位里多挂一个实例。
     * @param props.provider - 单个 provider 快照。
     * @param props.thresholds - { warn, critical }。
     * @param props.onRefresh - 点 ⟳ 时触发，已绑定到本 provider。
     * @param props.t - 字典函数。
     */
    function ProviderPage({ provider, thresholds, onRefresh, t }) {
      const status = statusOf(provider, t)
      const windows = provider.windows || []
      const balance = provider.balance || []
      const empty = windows.length === 0 && balance.length === 0
      // 过期态整卡降透明度：数据是真的，但「现在」不一定成立。用户一眼能看出虚化，
      // 同时仍读得出旧值——比换成「—」更有用。
      const staleDim = provider.stale === true && !empty

      const body = empty
        ? [h(EmptyState, { key: 'empty', provider, t })]
        : [
            ...windows.map((win) =>
              h(WindowRow, {
                key: win.key,
                label: windowLabel(win, t),
                entry: win,
                thresholds,
                t,
              }),
            ),
            ...balanceBlock(balance, windows.length > 0, t),
          ]

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: CARD_GAP + 'px',
            opacity: staleDim ? 0.55 : 1,
            transition: motion('opacity .25s var(--ds-ease-out, ease-out)'),
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', height: '18px' } },
          // 状态从「右上角一行字」收成标题左侧一个 6px 色点。
          // 「正常」是默认态，把 90% 的情况写出来只会稀释异常时的信号。
          h('span', {
            style: { width: '6px', height: '6px', borderRadius: '50%', background: status.color, flex: 'none' },
            'aria-hidden': 'true',
          }),
          h(
            'span',
            {
              style: {
                fontSize: '13px',
                fontWeight: 600,
                // 负字距：Linear 在小标题上用 -0.15 ~ -0.3，字看起来更「收」。
                letterSpacing: TRACK_TITLE,
                flex: '1',
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            provider.name,
          ),
          // 异常态才出文字，且紧贴刷新按钮——正常时这里应该是空的。
          status.text
            ? h('span', { style: { fontSize: '11px', color: status.color, flex: 'none' } }, status.text)
            : null,
          h(RefreshButton, { onClick: onRefresh, label: t('action.refresh') }),
        ),
        ...body,
        h(
          'div',
          {
            style: {
              height: FOOTER_ROW + 'px',
              display: 'flex',
              alignItems: 'center',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          h(
            'span',
            {
              style: { flex: '1', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: statusLine(provider, t),
            },
            statusLine(provider, t),
          ),
        ),
      )
    }

    /**
     * 余额块。
     *
     * 两种形态，按「有没有窗口」分：
     *  - 有窗口：窗口是主信息，余额退成一行带分隔线的辅助信息；
     *  - 只有余额（DeepSeek）：余额就是全部信息，用 22/600 大字占住视觉重心，
     *    剩下的空白从「没内容」变成「刻意的呼吸」。
     * @param balance - 余额项数组。
     * @param withWindows - 本页是否已经有窗口行。
     * @param t - 字典函数。
     * @returns 渲染节点数组（可能为空）。
     */
    function balanceBlock(balance, withWindows, t) {
      if (balance.length === 0) return []

      if (withWindows) {
        return [
          h('div', {
            key: 'wallet-rule',
            style: { height: '1px', background: 'var(--dsw-alias-border-l1)', marginTop: '1px' },
          }),
          h(
            'div',
            {
              key: 'wallet',
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', height: '16px' },
            },
            h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('balance.label')),
            h(
              'span',
              { style: { fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: TRACK_VALUE } },
              formatBalance(balance[0], t),
            ),
          ),
        ]
      }

      return [
        h(
          'div',
          {
            key: 'balance-hero',
            style: {
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: '2px',
              // 余额是本页唯一的信息，给它一块固定高度的舞台，而不是让 22px 的数字
              // 贴着页脚。高度跟着内容走之后，这里不撑开就会显得局促。
              minHeight: '56px',
            },
          },
          h(
            'span',
            {
              style: {
                fontSize: '22px',
                fontWeight: 600,
                lineHeight: '28px',
                fontVariantNumeric: 'tabular-nums',
                // 字号越大，负字距压得越多（Linear 的 -0.4 @22px、Stripe 的 -1.4 @display）。
                letterSpacing: TRACK_HERO,
              },
            },
            formatBalance(balance[0], t),
          ),
          h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('balance.label')),
        ),
      ]
    }

    /**
     * 空态：不复刻「标签 — 空条 — 「—」」的骨架。
     *
     * 空骨架看起来像加载失败；一句能行动的话（去登录 / 去订阅）才有用。
     * @param props.provider - 快照，用来判断缺的是凭证、订阅还是 workspace。
     * @param props.t - 字典函数。
     */
    function EmptyState({ provider, t }) {
      const reason = emptyReason(provider, t)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '2px' } },
        h('span', { style: { fontSize: '12px', fontWeight: 600 } }, reason.title),
        h('span', { style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } }, reason.hint),
      )
    }

    /**
     * 空态该说什么。
     *
     * 三种来源必须分开说——它们的处理动作完全不同：
     *   no-key          去登录 / 去填 key
     *   no-workspace    账号下没有可读额度的 workspace
     *   no-subscription 没订阅（或额度接口什么都没返回）
     * @param provider - 快照。
     * @param t - 字典函数。
     * @returns `{ title, hint }`。
     */
    function emptyReason(provider, t) {
      if (provider.state === 'no-key') {
        return { title: t('empty.noCredential'), hint: t('empty.noCredentialHint', { ref: provider.credentialLabel || '' }) }
      }
      if (provider.state === 'no-workspace') {
        return { title: t('empty.noWorkspace'), hint: t('empty.noWorkspaceHint') }
      }
      if (provider.state === 'no-subscription') {
        return { title: t('empty.noSubscription'), hint: t('empty.noSubscriptionHint') }
      }
      return { title: t('empty.unavailable'), hint: t('empty.unavailableHint') }
    }

    /**
     * 详情卡：一个 provider 一页，左右滑动切换。
     *
     * 为什么不是竖排一段一家：卡片是浮层，竖向堆叠会随家数一起长，很快就比窗口还高；
     * 而侧边栏页脚那边更是每多一家就要多占 44px。横向翻页把高度固定在「最高的那一页」，
     * 家数再多也一样，徽标也只需要一个。
     *
     * 页码圆点按各自的状态着色，所以停在 A 页时，B 页变红也一眼看得见——
     * 这是「只显示一家」这个选择必须付的补偿。
     *
     * 用 portal 挂到 document.body 并按视口坐标定位：侧边栏祖先上有 transform
     * 和 overflow:hidden，留原地会被裁剪或错位。
     * @param props.providers - 所有 provider 的快照，一页一家。
     * @param props.activeId - 当前页的 provider id。
     * @param props.onSelect - 用户滑到另一页时回调，参数是 provider id。
     * @param props.thresholds - { warn, critical }。
     * @param props.anchor - 徽标块的 getBoundingClientRect()。
     * @param props.onRefresh - 点 ⟳ 时触发，参数是 provider id。
     * @param props.onEnter - 指针进入卡片，取消待执行的关闭。
     * @param props.onLeave - 指针离开卡片，重新计时关闭。
     * @param props.onInteract - 卡片被按下，钉住不再自动关闭。
     * @param props.t - 字典函数。
     */
    function Card({ providers, activeId, onSelect, thresholds, anchor, onRefresh, onEnter, onLeave, onInteract, t }) {
      const pagerRef = useRef(null)
      const list = providers || []
      const index = Math.max(0, list.findIndex((provider) => provider.id === activeId))
      // 指针是否停在卡片上：只用来加深阴影，不动几何。
      const [hovered, setHovered] = useState(false)
      /**
       * 谁在驱动这次滚动。
       *
       * `'jump'`：卡片刚打开，按 activeId 一次性摆到位；
       * `'program'`：点了页码，正在平滑滚过去；
       * `null`：用户在触控板上自己滑。
       *
       * 只有在 `null` 时 onScroll 才回写选中项。否则平滑滚动**途经的中间页**会
       * 一次次把 activeId 改成第 2 页、第 3 页……徽标就跟着连续闪，这正是
       * 「翻页时状态栏撕裂」的来源。
       */
      const scrollOrigin = useRef('jump')
      /** 判定「这一轮滚动结束」的防抖把手。 */
      const scrollSettleTimer = useRef(null)

      // 打开时直接摆到当前页。没有这一步，卡片永远从第一家开始——
      // 而徽标可能正停在第三家，两边对不上，用户得手动点一次页码才同步。
      // 用 layout effect：必须在浏览器绘制前完成，否则会先闪一下第一页。
      useIsomorphicLayoutEffect(() => {
        const node = pagerRef.current
        if (!node || node.clientWidth === 0) return
        scrollOrigin.current = 'jump'
        node.scrollLeft = index * node.clientWidth
      }, [index])

      // 卸载时清掉待执行的定时器，免得在已卸载的组件上改状态。
      useEffect(() => () => {
        if (scrollSettleTimer.current !== null) clearTimeout(scrollSettleTimer.current)
      }, [])

      /**
       * 平滑滚动没有可靠结束事件（`scrollend` 还不够普及），所以用防抖：
       * 停止收到滚动事件一小段时间就算结束，把控制权交还给用户。
       */
      const settleScroll = () => {
        if (scrollSettleTimer.current !== null) clearTimeout(scrollSettleTimer.current)
        scrollSettleTimer.current = setTimeout(() => {
          scrollSettleTimer.current = null
          scrollOrigin.current = null
        }, 140)
      }

      // 切页时卡片高度要跟着当前页走。旧实现用「统一撑到最高页」回避了这个问题，
      // 代价是余额页大量空白。
      //
      // 注意这里有两层高度：卡片外壳（shell）和翻页容器（pager）。只给每页去掉
      // height:100% 没用——横向 flex 里每页都参与高度计算，pager 照样等于最高页。
      // 所以真正要做的是：量出**当前页**的内容高度，把它钉到 pager 上。
      //
      // 关键：**只让 pager 的 CSS transition 负责高度**。
      // 之前这里还额外用 play() 给 shell 补间，并且 effect 依赖 [index, pagerHeight]
      // 会跑两次——第二次在第一次的动画中途起步，于是看到「一顿一顿」。
      // 现在 effect 只负责测量与赋值，动画完全交给 pager 的 transition。
      const activePageRef = useRef(null)
      const [pagerHeight, setPagerHeight] = useState(null)

      useIsomorphicLayoutEffect(() => {
        const page = activePageRef.current
        if (!page) return
        // scrollHeight 取的是内容高度：容器被钉矮之后它也不会跟着缩，
        // 所以切换回来能立刻量回真实值。
        const next = Math.max(0, page.scrollHeight)
        setPagerHeight((prev) => (prev === next ? prev : next))
      }, [index])

      /** 跳到第 i 页：先滚过去，再同步选中项（滚动事件也会兜一次）。 */
      const goTo = (next) => {
        const clamped = Math.max(0, Math.min(list.length - 1, next))
        const node = pagerRef.current
        if (node) {
          scrollOrigin.current = 'program'
          node.scrollTo({ left: clamped * node.clientWidth, behavior: 'smooth' })
          settleScroll()
        }
        // 选中项立刻改：徽标与页码圆点应该马上响应点击，而不是等滚动动画结束。
        if (list[clamped]) onSelect(list[clamped].id)
      }

      /** 触控板横扫或拖动之后，把选中项同步回徽标。 */
      const onScroll = () => {
        // 程序驱动的滚动不参与回写：中间页不是用户的选择。
        if (scrollOrigin.current !== null) {
          settleScroll()
          return
        }
        const node = pagerRef.current
        if (!node || node.clientWidth === 0) return
        const at = Math.round(node.scrollLeft / node.clientWidth)
        const target = list[Math.max(0, Math.min(list.length - 1, at))]
        if (target && target.id !== activeId) onSelect(target.id)
      }

      const style = {
        position: 'fixed',
        zIndex: 9999,
        width: CARD_WIDTH + 'px',
        padding: CARD_PADDING + 'px',
        display: 'flex',
        flexDirection: 'column',
        gap: CARD_GAP + 'px',
        borderRadius: CARD_RADIUS + 'px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        // 三层薄阴影取代原来的单层重投影：近处收紧轮廓、中间给出体积、远处拉开
        // 与侧边栏的距离。Vercel 明确要求「never a single heavy drop-shadow」。
        boxShadow: hovered ? SHADOW_STACK_HOVER : SHADOW_STACK,
        color: 'var(--dsw-alias-label-primary)',
        // 卡片要能停留、能选中文字、能点按钮。
        userSelect: 'text',
        cursor: 'default',
        // 内容随页高变化时，浮动层不该在过渡期间被自己的旧高度裁掉。
        overflow: 'visible',
        // hover 时只加深阴影，不位移——浮层一移动会带着锚点错觉。
        transition: motion('box-shadow ' + CARD_RESIZE_MS + 'ms ' + SWAP_EASE),
      }
      if (anchor) {
        const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 16))
        style.left = left + 'px'
        // 贴着徽标上沿，只留视觉间隙；跨越它靠的是关闭宽限期。
        style.bottom = Math.max(8, window.innerHeight - anchor.top + 6) + 'px'
      }

      return h(
        'div',
        {
          style,
          role: 'dialog',
          'aria-label': (list[index] && list[index].name) || '',
          onMouseEnter: () => {
            setHovered(true)
            onEnter()
          },
          onMouseLeave: () => {
            setHovered(false)
            onLeave()
          },
          // 卡片内的按下既不能冒泡到"点外部关闭"，也要顺手钉住这张卡。
          onMouseDown: (event) => {
            event.stopPropagation()
            if (onInteract) onInteract()
          },
        },
        h(
          'div',
          {
            ref: pagerRef,
            onScroll,
            style: {
              display: 'flex',
              width: '100%',
              // 容器高度由**当前页**决定（见下面 pagerHeight 的测量）。
              // 横向 flex 里每页默认都参与高度计算，容器永远等于「最高那一页」——
              // 这正是余额页空白的根。把容器高度钉成当前页高度，空白就没了；
              // 其余页仍然完整渲染，横向滑动不受影响。
              height: pagerHeight === null ? undefined : pagerHeight + 'px',
              // 与徽标同一条缓动曲线：点页码时，卡片高度和状态栏数值应该像同一个动作。
              transition: motion('height ' + CARD_RESIZE_MS + 'ms ' + SWAP_EASE),
              // 滚动条在浮层里很扎眼，而且这里本来就有圆点指示位置。
              overflowX: 'auto',
              overflowY: 'hidden',
              scrollSnapType: 'x mandatory',
              scrollbarWidth: 'none',
              overscrollBehavior: 'contain',
              alignItems: 'flex-start',
            },
          },
          ...list.map((provider, i) =>
            h(
              'div',
              {
                key: provider.id,
                ref: i === index ? activePageRef : undefined,
                style: {
                  flex: '0 0 100%',
                  minWidth: 0,
                  scrollSnapAlign: 'start',
                },
              },
              h(ProviderPage, {
                provider,
                thresholds: thresholds || {},
                onRefresh: () => onRefresh(provider.id),
                t,
              }),
            ),
          ),
        ),
        // 只有一家时不需要页码，但仍保留一行的位置，避免卡片高度在
        // 「有页码 / 没页码」之间跳动。
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '5px' } },
          list.length > 1
            ? list.map((provider, i) =>
                h('button', {
                  key: provider.id,
                  type: 'button',
                  onClick: () => goTo(i),
                  title: provider.name,
                  'aria-label': provider.name,
                  'aria-current': i === index ? 'true' : undefined,
                  style: {
                    width: i === index ? '14px' : '5px',
                    height: '5px',
                    padding: 0,
                    border: 'none',
                    borderRadius: '2.5px',
                    cursor: 'pointer',
                    background: i === index ? toneFor(provider, thresholds || {}) : 'var(--dsw-alias-border-l2)',
                    opacity: i === index ? 1 : 0.9,
                    transition: motion('width .2s var(--ds-ease-in-out, ease), background .2s'),
                  },
                }),
              )
            : null,
        ),
      )
    }

    /**
     * 侧边栏页脚徽标。
     *
     * 悬停打开，移开后有一段宽限期才关闭 —— 徽标与卡片之间必然存在视觉间隙，
     * 没有宽限期时鼠标穿过间隙就会触发 mouseleave 把卡片卸载，⟳ 永远点不到。
     * 点徽标、或在卡片内按下，则「钉住」；此后只能靠 Esc / 点外部 / 再点徽标关闭，
     * 这样才选得中文字、点得到按钮。
     * @param props - 槽位下发；`wide === false` 表示侧边栏折叠，`t` 是框架注入的字典座位。
     */
    function QuotaBadge(props) {
      // `t` 由框架按注册时的 locale 命名空间注入，并且**切语言时会连同本组件一起重渲染**
      // （dsh-client-ui-renderer: "Every outlet re-renders on a locale switch"）。
      // 所以不要自己 ctx.locale.bind() 一个塞进来——那样不会跟随切换。
      const t = props.t
      const [data, setData] = useState({
        generatedAt: null,
        thresholds: { warn: 80, critical: 95 },
        providers: [],
      })
      const [open, setOpen] = useState(false)
      const [pinned, setPinned] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [hovered, setHovered] = useState(false)
      const [anchor, setAnchor] = useState(null)
      // 当前翻到哪一家。null = 跟着列表第一家；用户滑到别处后就不再自动改，
      // 徽标右侧一直报他选中的那一家，直到他再滑一次。
      //
      // 「上次翻到哪」由 Host 记住（/state 的 selectedId），不存 localStorage：
      // GUI 端口每次重启都会变，localStorage 按 origin 隔离，端口一变就全丢。
      const [activeId, setActiveId] = useState(null)
      /**
       * 是否已经用 Host 记录的选择初始化过。
       *
       * 为什么需要这个开关：首帧 providers 还是空数组，此时如果把 activeId
       * 落成 `providers[0]` 就会锁死成第一家，后面 selectedId 回来了也改不动。
       * 所以「第一次拿到数据」之前不写死选择，拿到之后尊重用户的显式翻页。
       */
      const hydrating = useRef(true)
      /** 上一次已经上报过的选择，避免同一页反复写入。 */
      const reported = useRef(null)
      const rootRef = useRef(null)
      const mounted = useRef(true)
      const closeTimer = useRef(null)

      const read = useCallback(async (force) => {
        if (force) setRefreshing(true)
        // force 为 true/'all' 时刷全部，传 provider id 时只刷那一家。
        const query = !force ? '' : force === true || force === 'all' ? '?refresh=all' : '?refresh=' + encodeURIComponent(force)
        try {
          const res = await fetch(STATE_PATH + query, { headers: { Accept: 'application/json' } })
          const body = await res.json()
          if (mounted.current) {
            setData(body)
            // 首次拿到数据时，用 Host 记住的选择开页；之后不再干预，
            // 否则每次轮询都会把用户刚翻到的那一页拽回去。
            if (hydrating.current) {
              hydrating.current = false
              const remembered = body && typeof body.selectedId === 'string' ? body.selectedId : null
              const exists = remembered !== null && (body.providers || []).some((p) => p.id === remembered)
              if (exists) {
                setActiveId(remembered)
                // 记成「已经上报过」：这个值本来就是从 Host 读回来的，
                // 不回填的话，用户从别家翻回这一页时会被当成一次新选择，
                // 白写一次盘（还会和 Host 上已存的值打架）。
                reported.current = remembered
              }
            }
          }
          // 把快照回给调度器，由它决定下一次是 1 秒还是 30 秒。
          return body
        } catch (error) {
          if (mounted.current) {
            // 路由本身不可达：保留 providers，只把每一家的状态翻成 network。
            setData((prev) => ({
              ...prev,
              providers: (prev.providers || []).map((p) => ({ ...p, ok: false, state: 'network', error: String((error && error.message) || error) })),
            }))
          }
          return null
        } finally {
          if (mounted.current) setRefreshing(false)
        }
      }, [])

      /**
       * 用户翻页/滑动后：更新本地选中项，并把选择告诉 Host。
       *
       * 写入是「尽力而为」：失败只影响下次启动能否恢复，不影响本次使用，
       * 所以不 await、不提示、不重试——翻页本身必须立刻有反馈。
       */
      const selectProvider = useCallback((id) => {
        setActiveId(id)
        if (id && id !== reported.current) {
          reported.current = id
          void fetch(SELECT_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedId: id }),
            // 页面正在关闭时也尽量让它发出去。
            keepalive: true,
          }).catch(() => {})
        }
      }, [])

      // 自调度而不是 setInterval：冷启动阶段要能临时提速（见 FAST_RETRY_MS）。
      // 隐藏时（最小化窗口、切到后台标签）跳过这轮读取——Host 有自己 5 分钟的
      // 上游轮询，前端只是读缓存，没必要在看不见的时候空转。
      useEffect(() => {
        mounted.current = true
        let alive = true
        let timer = null
        let fastLeft = FAST_RETRY_LIMIT

        const schedule = (delay) => {
          if (!alive) return
          timer = setTimeout(tick, delay)
        }

        const tick = async () => {
          if (!alive) return
          if (document.visibilityState === 'hidden') {
            schedule(READ_INTERVAL_MS)
            return
          }
          const body = await read(false)
          if (!alive) return
          if (fastLeft > 0 && needsFastRetry(body)) {
            fastLeft -= 1
            schedule(FAST_RETRY_MS)
          } else {
            schedule(READ_INTERVAL_MS)
          }
        }

        // 回到前台时把加速预算补满：切走再切回来，多半又是一次「还没数据」。
        const onVisibility = () => {
          if (document.visibilityState !== 'visible') return
          fastLeft = FAST_RETRY_LIMIT
          if (timer !== null) clearTimeout(timer)
          void tick()
        }

        void tick()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          mounted.current = false
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [read])

      const cancelClose = useCallback(() => {
        if (closeTimer.current !== null) {
          clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
      }, [])

      const openNow = useCallback(() => {
        cancelClose()
        const node = rootRef.current
        if (node) setAnchor(node.getBoundingClientRect())
        setOpen(true)
        // 展开时补读一次：读的是 Host 内存快照，不打上游，零成本。
        // 不做这一步的话，看到的可能是最多 30 秒前的数据。
        void read(false)
      }, [cancelClose, read])

      const closeNow = useCallback(() => {
        cancelClose()
        setOpen(false)
        setPinned(false)
      }, [cancelClose])

      const scheduleClose = useCallback(() => {
        if (pinned) return
        cancelClose()
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null
          setOpen(false)
        }, 260)
      }, [cancelClose, pinned])

      useEffect(() => () => cancelClose(), [cancelClose])

      // 打开期间：Esc 与点击外部关闭；同时跟随滚动/缩放重算锚点，免得卡片脱位。
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') closeNow()
        }
        const onDown = (event) => {
          const node = rootRef.current
          if (node && event.target instanceof Node && node.contains(event.target)) return
          closeNow()
        }
        const reposition = () => {
          const node = rootRef.current
          if (node) setAnchor(node.getBoundingClientRect())
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
        }
      }, [open, closeNow])

      const providers = data.providers || []
      const collapsed = props && props.wide === false
      const warn = (data.thresholds && data.thresholds.warn) || 80

      // 一家都没配：整块不渲染，页脚不留空行。
      if (providers.length === 0) return null

      // 徽标只报**当前翻到的那一家**的最紧窗口，不做跨 provider 聚合：
      // 两家各自的额度是两笔独立预算，合并成一个数字会让人
      // 以为是同一份额度，也看不出该去哪家省着用。
      // 只有余额、没有窗口的服务（DeepSeek 这类）在右侧直接显示余额。
      const active = providers.find((provider) => provider.id === activeId) || providers[0]
      const worst = worstWindow(active, t)
      const balance = active.balance || []
      // 形状由 provider 的种类决定，不看有没有数据——否则「刚启动还没拉到」会被画成
      // 另一种形状，读起来像换了家服务。余额型永远画实心圆底（见 Ring 的 filled）。
      const isBalance = active.kind === 'balance'
      const color = toneFor(active, data.thresholds)
      const staleBadge = hasContent(active) && active.stale === true
      let value
      if (worst) {
        value = worst.short + ' ' + percentText(worst.percent)
      } else if (isBalance && balance.length > 0) {
        value = formatBalance(balance[0], t)
      } else {
        // 「…」是「正在读」，「—」是「没有数据」。冷启动那几秒不该看起来像坏了。
        value = active.state === 'pending' ? '…' : '—'
      }
      // 越过警告线就让数字也上色，别只靠环；余额耗尽同理。
      const attention = worst !== null ? worst.percent >= warn : active.state === 'no-balance'
      const aria = worst
        ? t('badge.aria', {
            name: active.name,
            window: worst.label,
            percent: percentText(worst.percent).replace('%', ''),
            reset: formatReset(worst.entry.resetsAt, t),
          }) + (staleBadge ? t('badge.ariaStale') : '')
        : t('badge.ariaError', { name: active.name, reason: messageFor(active.state, active, t) })

      const card = open
        ? h(Card, {
            providers,
            activeId: active.id,
            onSelect: selectProvider,
            thresholds: data.thresholds,
            anchor,
            onRefresh: (id) => void read(id),
            onEnter: cancelClose,
            onLeave: scheduleClose,
            onInteract: () => setPinned(true),
            t,
          })
        : null
      return h(
        'div',
        {
          ref: rootRef,
          // 盒子与账号行的 triggerRow 对齐：向右各多出 2px，抵消账号行那对负外边距。
          // 折叠态下账号行收成 36×36 的方块，这里跟着收，否则会撑破 56px 的轨道。
          style: collapsed
            ? { position: 'relative', display: 'flex', flex: 'none', width: RAIL_SIZE + 'px', margin: '8px 0 10px' }
            : {
                position: 'relative',
                display: 'flex',
                flex: 'none',
                width: 'calc(100% + 4px)',
                margin: '0 -2px',
                minWidth: 0,
              },
          onMouseEnter: () => {
            setHovered(true)
            openNow()
          },
          onMouseLeave: () => {
            setHovered(false)
            scheduleClose()
          },
        },
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              if (pinned) closeNow()
              else {
                setPinned(true)
                openNow()
              }
            },
            onFocus: openNow,
            'aria-label': aria,
            'aria-expanded': open,
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : undefined,
              gap: ROW_GAP + 'px',
              boxSizing: 'border-box',
              width: '100%',
              height: (collapsed ? RAIL_SIZE : ROW_HEIGHT) + 'px',
              minWidth: 0,
              cursor: 'pointer',
              border: 'none',
              // 与侧边栏其他行（设置、账号、面板）保持一致——它们都有 hover 底色。
              // 内联样式写不了 :hover，所以用状态驱动。
              background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              borderRadius: 'var(--dsw-radius-md, 12px)',
              padding: collapsed ? 0 : ROW_PADDING + 'px',
              fontSize: '14px',
              lineHeight: '22px',
              textAlign: 'left',
              opacity: staleBadge ? 0.55 : 1,
            },
          },
          h(Ring, { percent: worst ? worst.percent : 0, color, mark: active.mark, filled: isBalance }),
          // 没有文字标签：识别由环内的品牌字承担。这里只留一个弹性占位，
          // 把数值推到右边缘——紧邻靠左会让内容缩成一小坨浮在左边。
          collapsed ? null : h('span', { style: { flex: '1', minWidth: 0 } }),
          collapsed
            ? null
            : h(SwappingText, {
                text: refreshing ? '⟳' : value,
                style: {
                  flex: 'none',
                  fontVariantNumeric: 'tabular-nums',
                  // 状态色与环弧、环心字同一条时间线；opacity 由 SwappingText 自己管，
                  // 这里不重复声明，免得两条 transition 在同一元素上打架。
                  color: attention ? color : 'var(--dsw-alias-label-primary)',
                  transition: motion('color ' + BADGE_SWAP_MS + 'ms ' + SWAP_EASE),
                  opacity: refreshing ? 0.45 : 1,
                },
              }),
        ),
        // portal 到 body：躲开侧边栏祖先的 overflow:hidden 与 transform。
        card ? (createPortal ? createPortal(card, document.body) : card) : null,
      )
    }

    /**
     * 错误边界。
     *
     * 组件自己抓不住自己的渲染异常——必须有父级类组件。没有它，任何一次渲染抛错
     * 都会让 React 卸载整棵子树，徽标直接从槽位里消失，而且不留痕迹。
     * 有了它，最坏情况只是那一行「OpenCode Go 不可用」，原因进 console。
     */
    class BadgeBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[opencode-go-quota] 徽标渲染失败：', error)
      }

      render() {
        if (this.state.error !== null) {
          // 兜底文案也走字典：props 里有框架注入的 t。
          const t = this.props.t
          const label = typeof t === 'function' ? t('error.failed') : 'Quota'
          return h(
            'div',
            {
              style: { padding: '7px 8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
              title: String(this.state.error),
            },
            label,
          )
        }
        return h(QuotaBadge, this.props)
      }
    }

    /**
     * 注册徽标到侧边栏页脚。
     * @param ctx - 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      try {
        // 字典注册成 owned effect，卸载时自动撤销。locale 服务要求同时给 zh 与 en。
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-go-quota: dictionaries')
        // 只用于注册项的 label（给工具/无障碍用），组件里的 t 由框架注入。
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'opencode-go-quota',
              order: 30,
              // 声明命名空间后，渲染器会注入随语言切换刷新的 t 座位，
              // 并在切语言时重渲染本 outlet。
              locale: NS,
              label: () => t('panel.label'),
            },
            BadgeBoundary,
          ),
        )
      } catch (error) {
        // 宁可徽标不显示，也不能让整个 web boot 因为一个入口失败而起不来。
        // 渲染层 console.error 会被写进 dsh-desktop 的 crash log，仍可诊断。
        console.error('[opencode-go-quota] 注册侧边栏徽标失败：', error)
      }
    }

    /**
     * Cordis 服务名，不是包名。缺了 slots，apply 里的 ctx.slots 就是 undefined，
     * fiber 会直接 FAILED 并让整个 web boot 报 "entry did not activate"。
     * 缺了 locale，注册项声明 locale 时渲染器会抛 SlotAssemblyError。
     * @see @deepseek-ai/dsh-client-ui-jobs/lib/client.js:596
     */
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

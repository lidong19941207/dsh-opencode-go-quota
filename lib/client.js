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
    const { useState, useEffect, useRef, useCallback } = React

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
    /** 客户端读取间隔：Host 侧另有自己的轮询节奏。 */
    const READ_INTERVAL_MS = 30_000

    /**
     * 环的几何。环内嵌的是品牌字「Go」——品牌不翻译，所以它不走字典。
     *
     * 尺寸由几何决定，不能随意改小：内径 = 直径 − 2×描边。
     * 24px / 3px → 内径 18px；「Go」在 11px 时宽约 14px，左右各余 2px。
     * 若缩到 16px / 2.5px，内径仅 11px，「Go」最大只能取到 7px 而无法辨认。
     */
    const RING_SIZE = 24
    const RING_STROKE = 3
    const RING_TEXT_SIZE = 11

    /** 语言命名空间。交给槽位注册后，框架会注入随语言切换自动刷新的 `t`。 */
    const NS = 'opencode-go-quota'

    /**
     * 字典。locale 服务要求**同时提供 zh 与 en**；其余语言沿 fallback 链落到 en。
     *
     * 刻意不用复数键（`.one`/`.other`）：时间一律用缩写（`12d 17h` / `12 天 17 小时`），
     * 绕开复数规则，字典能小一半。
     */
    const zh = {
      'badge.aria': 'OpenCode Go 额度：{window} 已用 {percent}%，{reset}',
      'badge.ariaStale': '，数据可能已过期',
      'badge.ariaError': 'OpenCode Go 额度：{reason}',
      'panel.label': 'OpenCode Go 额度',
      'window.rolling': '5 小时',
      'window.weekly': '本周',
      'window.monthly': '本月',
      'window.rolling.short': '5h',
      'window.weekly.short': '周',
      'window.monthly.short': '月',
      'status.ok': '正常',
      'status.limited': '已限流',
      'status.stale': '数据过期',
      'status.unavailable': '不可用',
      'reset.soon': '即将重置',
      'reset.days': '{days} 天 {hours} 小时后重置',
      'reset.hours': '{hours} 小时 {minutes} 分后重置',
      'reset.minutes': '{minutes} 分钟后重置',
      'row.limited': '已限流 · {reset}',
      'row.empty': '暂无数据',
      'ago.seconds': '{seconds} 秒前',
      'ago.minutes': '{minutes} 分钟前',
      'ago.hours': '{hours} 小时前',
      'footer.refreshed': '{ago}刷新',
      'footer.stale': '数据 {ago} · {reason}',
      'action.refresh': '立即刷新',
      'error.noKey': '凭证 {ref} 未配置',
      'error.badKey': 'API key 无效',
      'error.noSubscription': '当前账号未订阅 OpenCode Go',
      'error.network': '网络不可达',
      'error.pending': '正在读取…',
      'error.unavailable': '数据不可用',
      'error.failed': 'OpenCode Go 不可用',
    }

    const en = {
      'badge.aria': 'OpenCode Go quota: {window} at {percent}%, {reset}',
      'badge.ariaStale': ', data may be out of date',
      'badge.ariaError': 'OpenCode Go quota: {reason}',
      'panel.label': 'OpenCode Go quota',
      // 标签格固定 56px（@13px），太长会折行把整行的对齐全打乱：
      // 'Last 5 hours' 69.2px / 'This month' 64.4px 都会溢出，'This week' 55.9px 也只剩 0.1px。
      // 所以英文用短名，中文那三个本来就只有 16~27px。
      'window.rolling': '5 hours',
      'window.weekly': 'Week',
      'window.monthly': 'Month',
      'window.rolling.short': '5h',
      'window.weekly.short': 'Wk',
      'window.monthly.short': 'Mo',
      'status.ok': 'Normal',
      'status.limited': 'Rate limited',
      'status.stale': 'Stale',
      'status.unavailable': 'Unavailable',
      'reset.soon': 'resetting soon',
      'reset.days': 'resets in {days}d {hours}h',
      'reset.hours': 'resets in {hours}h {minutes}m',
      'reset.minutes': 'resets in {minutes}m',
      'row.limited': 'Rate limited · {reset}',
      'row.empty': 'No data',
      'ago.seconds': '{seconds}s ago',
      'ago.minutes': '{minutes}m ago',
      'ago.hours': '{hours}h ago',
      'footer.refreshed': 'Refreshed {ago}',
      'footer.stale': 'Data from {ago} · {reason}',
      'action.refresh': 'Refresh now',
      'error.noKey': 'Missing {ref}',
      'error.badKey': 'Invalid API key',
      'error.noSubscription': 'This account has no OpenCode Go subscription',
      'error.network': 'Network unreachable',
      'error.pending': 'Loading…',
      'error.unavailable': 'Data unavailable',
      'error.failed': 'OpenCode Go unavailable',
    }

    /**
     * 三个窗口。文案存的是**字典键**而不是字面串——字面串在注册那一刻就被冻结了，
     * 切语言不会更新。
     */
    const WINDOWS = [
      { key: 'rolling', labelKey: 'window.rolling', shortKey: 'window.rolling.short' },
      { key: 'weekly', labelKey: 'window.weekly', shortKey: 'window.weekly.short' },
      { key: 'monthly', labelKey: 'window.monthly', shortKey: 'window.monthly.short' },
    ]

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
     * @param usage - Host 返回的 usage 对象。
     * @param t - 字典函数，用来把窗口名翻译出来。
     * @returns 最紧的窗口，或 null（无数据）。
     */
    function worstWindow(usage, t) {
      let worst = null
      if (!usage) return null
      for (const window of WINDOWS) {
        const entry = usage[window.key]
        if (!entry || typeof entry.percent !== 'number') continue
        if (worst === null || entry.percent > worst.percent) {
          worst = {
            key: window.key,
            label: t(window.labelKey),
            short: t(window.shortKey),
            percent: entry.percent,
            entry,
          }
        }
      }
      return worst
    }

    /**
     * 卡片底部那行状态文案。
     * @param data - Host 返回的完整状态。
     * @param t - 字典函数。
     * @returns 展示文本。
     */
    function statusLine(data, t) {
      if (data.ok) return t('footer.refreshed', { ago: formatAgo(data.fetchedAt, t) })
      const reason = messageFor(data.state, data.error, data.apiKeyRef, t)
      // 有旧数据却说「不可用」是误导：明确标出这份数据是什么时候的。
      if (data.usage && data.fetchedAt) return t('footer.stale', { ago: formatAgo(data.fetchedAt, t), reason })
      return reason
    }

    /**
     * 失败状态文案。
     * @param state - Host 归一出的状态码。
     * @param error - 原始错误文本（只在状态码未知时兜底，故可能是 Host 侧语言）。
     * @param apiKeyRef - 使用的凭证名。
     * @param t - 字典函数。
     * @returns 展示文本。
     */
    function messageFor(state, error, apiKeyRef, t) {
      if (state === 'no-key') return t('error.noKey', { ref: apiKeyRef || 'OPENCODE_GO_API_KEY' })
      if (state === 'bad-key') return t('error.badKey')
      if (state === 'no-subscription') return t('error.noSubscription')
      if (state === 'network') return t('error.network')
      if (state === 'pending') return t('error.pending')
      return error || t('error.unavailable')
    }

    /**
     * 环形进度，中心内嵌品牌字「Go」。
     *
     * 环因此同时承担两件事：进度（弧）与标识（中心字）。代价是弧相对环身变细、
     * 中心字会分走一点注意力，所以右侧那个百分比数值仍然保留——一眼扫不出精确
     * 进度时还有它兜底。
     * @param props.percent - 已用百分比。
     * @param props.color - 弧与中心字的颜色。
     */
    function Ring({ percent, color }) {
      const px = RING_SIZE
      const stroke = RING_STROKE
      const r = (px - stroke) / 2
      const c = 2 * Math.PI * r
      const value = Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0))
      return h(
        'svg',
        { width: px, height: px, viewBox: '0 0 ' + px + ' ' + px, 'aria-hidden': 'true', style: { flex: 'none' } },
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
          style: { transition: 'stroke-dashoffset .3s var(--ds-ease-in-out, ease)' },
        }),
        h(
          'text',
          {
            x: px / 2,
            y: px / 2,
            textAnchor: 'middle',
            dominantBaseline: 'central',
            fontSize: RING_TEXT_SIZE + 'px',
            fontWeight: 600,
            fill: color,
            // SVG 文字默认不继承页面字体，显式继承侧边栏的字体栈。
            style: { fontFamily: 'inherit' },
          },
          'Go',
        ),
      )
    }

    /**
     * 一条窗口进度条。
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
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '13px' } },
          h(
            'span',
            {
              style: {
                width: '56px',
                flex: 'none',
                // 必须 nowrap：标签格是固定宽度，长文案折行会把这一行和下面那行
                // （缩进对齐的重置时间）的对齐全部打乱。溢出时省略号截断。
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: worst ? color : 'var(--dsw-alias-label-secondary)',
              },
              title: label,
            },
            label,
          ),
          h(
            'span',
            { style: { flex: '1', height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' } },
            h('span', {
              style: {
                display: 'block',
                height: '100%',
                width: Math.max(0, Math.min(100, percent || 0)) + '%',
                background: color,
                borderRadius: '3px',
                transition: 'width .3s var(--ds-ease-in-out, ease)',
              },
            }),
          ),
          h(
            'span',
            { style: { width: '38px', flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: limited ? color : 'var(--dsw-alias-label-primary)' } },
            typeof percent === 'number' ? percent + '%' : '—',
          ),
        ),
        h(
          'div',
          { style: { paddingLeft: '64px', fontSize: '11px', color: limited ? color : 'var(--dsw-alias-label-secondary)' } },
          // entry 可能整个缺失：尚未拿到数据，或该窗口字段未返回。必须显式判空——
          // 直接读 entry.resetsAt 会在渲染期抛错，React 随即卸载整棵子树，
          // 徽标会从槽位里消失且不留痕迹。
          entry === undefined || entry === null
            ? t('row.empty')
            : limited
              ? t('row.limited', { reset: formatReset(entry.resetsAt, t) })
              : formatReset(entry.resetsAt, t),
        ),
      )
    }

    /**
     * 详情卡。
     *
     * 用 portal 挂到 document.body 并按视口坐标定位：侧边栏祖先上有 transform
     * 和 overflow:hidden，留原地会被裁剪或错位。
     * @param props.data - Host 返回的完整状态。
     * @param props.anchor - 徽标的 getBoundingClientRect()。
     * @param props.onRefresh - 点 ⟳ 时触发。
     * @param props.onEnter - 指针进入卡片，取消待执行的关闭。
     * @param props.onLeave - 指针离开卡片，重新计时关闭。
     * @param props.onInteract - 卡片被按下，钉住不再自动关闭。
     * @param props.t - 字典函数。
     */
    function Card({ data, anchor, onRefresh, onEnter, onLeave, onInteract, t }) {
      const usage = data.usage || {}
      const thresholds = data.thresholds || {}
      const limited = WINDOWS.some((w) => usage[w.key] && usage[w.key].status === 'rate-limited')
      const worst = worstWindow(usage, t)
      const hasUsage = data.usage !== null && data.usage !== undefined
      // 卡头右侧放状态，而不是凭证名——凭证名不随使用变化，不提供额外信息；真正需要它的
      // 时候（凭证缺失/失效）statusLine 会自己把 ref 带出来。
      const status = data.ok
        ? limited
          ? { text: t('status.limited'), color: 'var(--dsw-alias-state-error-primary)' }
          : { text: t('status.ok'), color: 'var(--dsw-alias-state-success-primary)' }
        : hasUsage
          ? { text: t('status.stale'), color: 'var(--dsw-alias-state-warn-primary)' }
          : { text: t('status.unavailable'), color: 'var(--dsw-alias-state-idle-primary)' }
      const style = {
        position: 'fixed',
        zIndex: 9999,
        width: '272px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 8px 28px rgba(0,0,0,.18)',
        color: 'var(--dsw-alias-label-primary)',
        // 卡片要能停留、能选中文字、能点按钮。
        userSelect: 'text',
        cursor: 'default',
      }
      if (anchor) {
        const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 288))
        style.left = left + 'px'
        // 贴着徽标上沿，只留视觉间隙；跨越它靠的是关闭宽限期。
        style.bottom = Math.max(8, window.innerHeight - anchor.top + 6) + 'px'
      }

      return h(
        'div',
        {
          style,
          role: 'dialog',
          'aria-label': t('panel.label'),
          onMouseEnter: onEnter,
          onMouseLeave: onLeave,
          // 卡片内的按下既不能冒泡到"点外部关闭"，也要顺手钉住这张卡。
          onMouseDown: (event) => {
            event.stopPropagation()
            if (onInteract) onInteract()
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'OpenCode Go'),
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: status.color } },
            h('span', {
              style: { width: '6px', height: '6px', borderRadius: '50%', background: status.color, flex: 'none' },
              'aria-hidden': 'true',
            }),
            status.text,
          ),
        ),
        ...WINDOWS.map((w) =>
          h(WindowRow, {
            key: w.key,
            label: t(w.labelKey),
            entry: usage[w.key],
            thresholds,
            worst: worst !== null && worst.key === w.key,
            t,
          }),
        ),
        h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l1)' } }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
          h(
            'span',
            {
              style: { flex: '1', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: statusLine(data, t),
            },
            statusLine(data, t),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onRefresh,
              title: t('action.refresh'),
              'aria-label': t('action.refresh'),
              style: {
                cursor: 'pointer',
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: '13px',
                lineHeight: 1,
                padding: '4px 6px',
                borderRadius: 'var(--dsw-radius-sm, 4px)',
              },
            },
            '⟳',
          ),
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
        ok: false,
        state: 'pending',
        usage: null,
        fetchedAt: null,
        lastAttemptAt: null,
        stale: false,
        error: null,
      })
      const [open, setOpen] = useState(false)
      const [pinned, setPinned] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [hovered, setHovered] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const rootRef = useRef(null)
      const mounted = useRef(true)
      const closeTimer = useRef(null)

      const read = useCallback(async (force) => {
        if (force) setRefreshing(true)
        try {
          const res = await fetch(STATE_PATH + (force ? '?refresh=1' : ''), { headers: { Accept: 'application/json' } })
          const body = await res.json()
          if (mounted.current) setData(body)
        } catch (error) {
          if (mounted.current) {
            setData((prev) => ({ ...prev, ok: false, state: 'network', error: String((error && error.message) || error) }))
          }
        } finally {
          if (mounted.current) setRefreshing(false)
        }
      }, [])

      // 隐藏时（最小化窗口、切到后台标签）跳过这轮读取——Host 有自己 5 分钟的
      // 上游轮询，前端只是读缓存，没必要在看不见的时候空转。
      useEffect(() => {
        mounted.current = true
        void read(false)
        const tick = () => {
          if (document.visibilityState === 'hidden') return
          void read(false)
        }
        const timer = setInterval(tick, READ_INTERVAL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void read(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          mounted.current = false
          clearInterval(timer)
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

      const usage = data.usage || {}
      // 徽标报的是**最紧的那个窗口**，不是月窗口。只看月窗口会在
      // 「5 小时已 95%、月才 45%」时显示成绿色的 45%，低估实际风险。
      const worst = worstWindow(usage, t)
      const hasData = worst !== null
      const color = hasData ? toneOf(worst.percent, data.thresholds) : 'var(--dsw-alias-state-idle-primary)'
      const value = hasData ? worst.short + ' ' + worst.percent + '%' : '—'
      const collapsed = props && props.wide === false
      // 数据不可用时压低不透明度：数字照给，但一眼看得出它不是当前的。
      const stale = hasData && data.stale === true
      const ariaLabel = hasData
        ? t('badge.aria', {
            window: worst.label,
            percent: worst.percent,
            reset: formatReset(worst.entry.resetsAt, t),
          }) + (stale ? t('badge.ariaStale') : '')
        : t('badge.ariaError', { reason: messageFor(data.state, data.error, data.apiKeyRef, t) })
      // 越过警告线就让数字也上色，别只靠环。
      const warn = (data.thresholds && data.thresholds.warn) || 80
      const attention = hasData && worst.percent >= warn

      const card = open
        ? h(Card, {
            data,
            anchor,
            onRefresh: () => void read(true),
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
          style: { position: 'relative', display: 'flex', width: '100%', minWidth: 0 },
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
            'aria-label': ariaLabel,
            'aria-expanded': open,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              minWidth: 0,
              cursor: 'pointer',
              border: 'none',
              // 与侧边栏其他行（设置、面板）保持一致——它们都有 hover 底色。
              // 内联样式写不了 :hover，所以用状态驱动。
              background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              borderRadius: 'var(--dsw-radius-md, 8px)',
              padding: '7px 8px',
              fontSize: '14px',
              lineHeight: '22px',
              textAlign: 'left',
              opacity: stale ? 0.55 : 1,
            },
          },
          h(Ring, { percent: hasData ? worst.percent : 0, color }),
          // 没有文字标签：识别由环内的「Go」承担。这里只留一个弹性占位，
          // 把数值推到右边缘——紧邻靠左会让内容缩成一小坨浮在左边。
          collapsed ? null : h('span', { style: { flex: '1', minWidth: 0 } }),
          collapsed
            ? null
            : h(
                'span',
                {
                  style: {
                    flex: 'none',
                    fontVariantNumeric: 'tabular-nums',
                    color: attention ? color : 'var(--dsw-alias-label-primary)',
                    opacity: refreshing ? 0.45 : 1,
                  },
                },
                refreshing ? '⟳' : value,
              ),
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
          const label = typeof t === 'function' ? t('error.failed') : 'OpenCode Go'
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

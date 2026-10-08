# Changelog

本项目的所有重要变更都记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-08

首个版本。

### Added

- 侧边栏页脚徽标（`sidebar.footer.action` 槽位）：环内嵌品牌字「Go」，弧长表示最紧窗口的已用百分比
- 悬停卡片：三个窗口的进度条、重置倒计时、数据新鲜度与手动刷新
- Host 半边：经凭证服务读取 OpenCode Go API key，自调度轮询上游 `/zen/go/v1/usage`
- 同源只读路由 `GET /opencode-go-quota/state`，经 `ctx.connection.admit()` 复用应用统一的请求信任策略
- 中英文字典，跟随 DSH 语言设置即时切换
- 失败退避：连续失败时按指数放大轮询间隔，上限可配置
- 离线测试：客户端渲染测试与 Host 逻辑测试

### Notes

以下为影响外部行为的设计取舍，记录在此便于日后回溯：

- **徽标显示最接近上限的窗口**，而非固定的月度窗口。三个窗口平级，任一打满即限流。
- **失败时保留上一次成功的数据**并以 `stale` 标记，不清空展示。
- **数据经同源 HTTP 路由传递**。`dsh-api-remotes` 的客户端命名空间集为构建期固定列表，插件无法扩展。
- **Host 半边不依赖 DSH 内部包**。插件安装在 profile 目录下，而 `CredentialRef` 在运行时为普通字符串。

[Unreleased]: https://github.com/lidong19941207/dsh-opencode-go-quota/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lidong19941207/dsh-opencode-go-quota/releases/tag/v0.1.0

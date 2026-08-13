# 更新日志

本项目的正式版本变更记录在此文件中。

## [0.2.2] - 2026-08-13

### 修复

- 修复通过 Cloudflare Builds 更新时可能绕过 D1 迁移、导致新版 Worker 因缺少
  `0020_device_token_scopes.sql` 而返回 `500` 的问题；Worker 会安全补齐并登记该迁移。

### 安全

- 为设备会话增加持久化 Scope；现有桌面令牌保持完整权限，OmniMail Float 新令牌仅
  能读取域名与邮箱、创建邮箱、读取邮件及标记已读，访问管理、发信、删除和账户
  设置接口时返回 `403`。
- Refresh Token 轮换会继承原会话 Scope，不能通过刷新扩大权限；设备列表与令牌
  响应会返回当前 Scope。
- 服务端强制 `SETUP_TOKEN` 至少为 32 个 UTF-8 字节，并对首次初始化实行每 IP 与
  全局 15 分钟限速，超限返回 `429` 和 `Retry-After`。
- 初始化完成后，公开的 `/api/config` 不再返回 `SUPER_ADMIN_EMAIL`。

### 测试

- 新增 Cloudflare Workers Vitest 集成测试，在 workerd/Miniflare 中应用全部 D1 迁移，
  操作真实 D1、R2 与 Queue 绑定，并验证扩展 Scope、令牌刷新及初始化安全边界。
- CI 新增 `npm run test:worker`，与现有 Node 单测、构建、E2E 和 Wrangler dry-run
  共同作为发布门禁。

### 发布

- 网页应用与 OmniMail Float 扩展版本统一为 `0.2.2`。

## [0.2.1] - 2026-08-13

### 新增

- 发布 OmniMail Float 浏览器扩展：支持在普通网页悬浮生成邮箱、自动填入邮箱输入框、
  查看收件箱与邮件详情，并接收新邮件通知。
- 新增网站授权扩展流程，使用 Chrome Identity、一次性授权码与 PKCE S256；设备令牌
  可撤销，密码和 MFA 始终只在 OmniMail 网站中处理。
- 新增扩展自定义邮箱、随机邮箱、最近邮件自动刷新、右侧停靠与布局恢复。
- 新增 Chrome Web Store 隐私声明、商店素材、真实 Chromium smoke 测试及独立发布
  会话脚本。
- 新增 Deploy to Cloudflare 配置，覆盖 D1、R2、Queue、Workflow、Workers AI 与静态
  资源绑定。
- 新增邮件搜索、消息列表索引和数据库基线迁移，改善大型邮箱的数据查询与升级流程。

### 修复

- 修复 Linux DO 登录后丢失扩展授权页路径与查询参数的问题。
- 修复扩展令牌刷新遇到临时网络或服务端错误时错误清除登录状态的问题；仅在刷新令牌
  被明确拒绝时退出登录。
- 修复快速切换邮箱时较早请求覆盖当前邮件列表的竞态问题。
- 修复扩展 smoke 测试默认覆盖 Chrome Web Store 正式图片素材的问题。
- 加强扩展来源校验、授权回调验证、会话过期处理和邮件 HTML 隔离。

### 发布

- 网页应用与 OmniMail Float 扩展版本统一为 `0.2.1`。
- Chrome Web Store 条目 `fpeecjailboemocpmpcbjaghpkpcaihf` 已提交 `0.2.1` 审核，
  审核通过后自动公开发布。

[0.2.1]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.2.1
[0.2.2]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.2.2

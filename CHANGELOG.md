# 更新日志

本文件保留聚合版本历史。GitHub Release 使用
[`docs/releases`](./docs/releases/README.md) 中与 Tag 同名的独立 Markdown 文件。
后续 Web、OmniMail Float 与 Android 分别使用 `vX.Y.Z`、`float-vX.Y.Z` 和
`android-vX.Y.Z`，三套版本号互不影响；以下既有历史记录保持不变。

## [0.2.5] - 2026-08-15

### 新增

- 新增完整的邮箱地址管理：普通邮箱可以启用、停用、设为主邮箱或经二次确认后删除。
- 删除邮箱时先立即隐藏地址，再由 Cloudflare Workflow 分批永久清理对应邮件、草稿、
  附件和主存储对象；主邮箱不能删除，清理任务启动失败时会恢复原状态。
- 快速生成邮箱支持输入自定义前缀；管理员可以配置随机邮箱固定前缀，网页应用和
  OmniMail Float 会共享该设置。

### 改进

- 随机邮箱地址统一使用 12 位十六进制随机字符；固定前缀默认留空，不再强制使用
  `omni-`，可在系统设置中配置最多 20 个字符的前缀。
- 新增版本化发布说明目录与模板，GitHub Release 会直接使用与 Tag 同名的 Markdown
  文件，缺失或空文件会阻止发布。

### 测试

- 新增邮箱主地址切换、删除与异步清理、随机前缀配置和地址格式校验的单元测试。
- 新增自定义邮箱创建、设为主邮箱与删除旧地址的端到端测试，并更新扩展 smoke 测试。

### 升级说明

- 无需新增 D1 迁移、环境变量或 Secret；部署仍需现有 `CLEANUP_WORKFLOW` 绑定。

### 发布

- 网页应用与 OmniMail Float 扩展版本统一为 `0.2.5`，GitHub Release 包含扩展 ZIP。

## [0.2.4] - 2026-08-14

### 新增

- 内置 Chrome Web Store 正式版 OmniMail Float 的固定扩展 ID，主管理员可在
  **系统设置 → 官方浏览器扩展** 中直接开启或关闭，无需配置 `APP_ORIGINS`。
- 新增全局扩展开关 API 与中英文设置卡片；开发版和其他扩展 ID 仍可继续通过
  `APP_ORIGINS` 精确配置。

### 安全

- 官方扩展默认关闭；关闭时同时拒绝固定来源的 CORS、授权码签发、授权码兑换和
  后续 API 请求。
- 即使固定商店来源被重复写入 `APP_ORIGINS`，也不能绕过主管理员的全局开关。

### 测试

- 新增官方扩展来源、授权流程、公开配置及主管理员权限的回归测试。
- 完整单元测试、Worker 类型检查、前端生产构建及发布门禁均覆盖该功能。

### 发布

- 网页应用版本升级为 `0.2.4`；Chrome Web Store 的 OmniMail Float 保持
  `0.2.1`，本次不发布新的扩展包。

## [0.2.3] - 2026-08-14

### 修复

- 修复 `v0.1.0` 至 `v0.1.4` 使用运行时建库、没有 Wrangler
  `d1_migrations` 表时，直接升级会因查询迁移记录失败而返回 `500` 的问题。
- Worker 会根据已知的旧版 `schema_version` 创建 Wrangler 兼容的迁移记录，按顺序
  补齐 `0015` 至 `0020`；此前迁移失败留下空记录表的数据库也可以继续恢复。
- `npm run db:migrate` 会先安全引导已知旧库的 Wrangler 迁移基线，修复手动部署在
  新 Worker 上线前就从 `0001` 开始执行并发生表冲突的问题；远程迁移改用 D1 文件
  导入通道，兼容包含 SQLite Trigger 的迁移文件。
- 无法识别的数据库结构不会被猜测性标记为已迁移，仍会返回明确的迁移提示。

### 测试

- 新增三条旧版结构基线、空迁移表及并发迁移的单元回归测试。
- Worker 集成测试现在会实际删除 `d1_migrations`，验证旧库恢复后可再次交由
  Wrangler 检查且不会重复执行迁移。

### 发布

- 网页应用与 OmniMail Float 扩展版本统一为 `0.2.3`。

## [0.3.0] - 2026-08-13

### 新增

- 将 OmniIMail 的 iCloud+ Hide My Email 能力融合为 OmniMail 的独立 `/icloud`
  工作区，共用现有登录、用户权限、主题、语言与响应式导航。
- 支持连接 `icloud.com` / `icloud.com.cn` 账号，同步、创建、停用、恢复和删除隐藏
  邮箱地址。
- 支持应用专用密码验证、iCloud IMAP 最近来信与完整正文读取；全部邮件视图在 IMAP
  不可用时回退到 iCloud Web 摘要。
- 新增 `ICLOUD_CREDENTIALS_KEY`，使用带用户、账号和字段上下文的 AES-GCM 加密
  iCloud Cookie 与应用专用密码；API 永不回传凭据。
- 新增 D1 迁移 `0021_icloud_accounts.sql`、iCloud API、部署自检项，以及 Node / workerd
  的加密、解析、迁移、用户隔离和 Scope 回归测试。

### 说明

- iCloud 邮件按需从 Apple 读取，不复制到 OmniMail 的 D1、R2 或现有收件箱。
- OmniMail Float 的受限设备令牌默认不能访问 iCloud 凭据与接口。
- Web 预览版本为 `0.3.0`；OmniMail Float 保持独立版本，不包含 iCloud 管理接口。

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
[0.2.3]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.2.3
[0.2.4]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.2.4
[0.2.5]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.2.5
[0.3.0]: https://github.com/mibgb65-cloud/OmniMail/releases/tag/v0.3.0

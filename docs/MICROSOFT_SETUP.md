# Microsoft 邮箱设置指南

OmniMail 用同一份 OAuth2 凭据经两条受控通道访问用户自己有权使用的 Microsoft 邮箱：
Microsoft Graph（`https://graph.microsoft.com/v1.0`）和 IMAP（固定 `outlook.office365.com:993`
TLS + XOAUTH2）。Worker 自动试探并回退，新账号先试 Graph，成功的通道会被记住。只允许读取与
精确标记已读；只支持 OAuth2，不再接受仅邮箱密码凭据，也不会使用 IMAP LOGIN。

支持 Azure Global 上的 Outlook.com、Hotmail、Live 与 Microsoft 365 委托式账号；租户关闭 IMAP
的账号会自动走 Graph。不支持世纪互联、中国区、GCC High 或 DoD 端点。

## 1. 部署配置

1. 在 Worker 的 **Variables & Secrets** 中新增 Secret `MICROSOFT_CREDENTIALS_KEY`。
   值必须至少包含 32 个随机 UTF-8 字节，并在迁移或恢复部署时保持不变。
2. 可选新增 Text 变量 `MICROSOFT_MAIL_ENABLED=true`。设为 `false` 会隐藏入口并停止定时入队，
   但不会删除已保存的账号、密文或索引。
3. 应用 D1 迁移 `0027_microsoft_imap.sql`、`0028_microsoft_oauth_combination_password.sql` 与
   `0036_microsoft_transport_channel.sql`，然后重新部署 Worker。`0036` 会重建
   `microsoft_imap_messages`，并在该表非空时主动失败中止；升级已有数据的部署前先确认表为空，
   或改走「建新表 + 回填」路径。
4. 确认 `MAIL_QUEUE` producer/consumer 与 `*/5 * * * *` Cron 已按 `wrangler.jsonc` 绑定。
5. 主管理员可在 **系统设置 → 邮箱功能入口** 中隐藏或恢复 Microsoft 入口。

本地开发可复制示例变量：

```text
MICROSOFT_CREDENTIALS_KEY=replace-with-at-least-32-random-bytes
MICROSOFT_MAIL_ENABLED=true
```

不要把真实密钥、refresh token、access token 或密码提交到 Git。

## 2. OAuth2 准备

导入 OAuth2 账号需要同一应用和用户配套的：

- 邮箱地址；
- refresh token；
- Client ID（UUID）；
- authority：`common`、`consumers`、`organizations` 或具体 tenant UUID。

签发 refresh token 时，应用需要委托式权限中的**任一组**（两组都有最好）加 `offline_access`：

- Graph 通道：`Mail.Read`（列信、读正文）和 `Mail.ReadWrite`（标已读）。只有 `Mail.Read` 的
  账号仍可收信，但已读回写会被 Graph 拒绝并把账号标为「权限不足」。
- IMAP 通道：`https://outlook.office.com/IMAP.AccessAsUser.All`。

2026-09-01 用 20 个只为 IMAP 签发的真实 refresh token 实测：无需重新授权即可换取带
`Mail.ReadWrite` 的 Graph token。OmniMail 不内置或借用任何第三方 Client ID，也不负责绕过租户
同意、条件访问或管理员策略。授权与 refresh token 行为见
[Microsoft Graph 权限](https://learn.microsoft.com/en-us/graph/permissions-reference#mail-permissions)、
[Microsoft IMAP OAuth 文档](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)和
[Microsoft OAuth 授权码流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)。

导入后，Worker 按通道向同一个 endpoint 申请不同 scope：

```text
POST https://login.microsoftonline.com/{authority}/oauth2/v2.0/token
# Graph 通道
scope=https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access
# IMAP 通道
scope=https://outlook.office.com/IMAP.AccessAsUser.All offline_access
```

两种 access token 不可互换，分别缓存。成功兑换后才会连接对应通道。若 Microsoft 返回轮换后的
refresh token，OmniMail 会在账号级刷新租约保护下原子替换旧密文。IMAP XOAUTH2 失败时只允许强制
刷新并重试一次，不会改用密码。

## 3. 导入格式

Microsoft 工作区提供 **分字段录入** 和 **批量导入** 两种入口。分字段录入适合单个账号，或
password 本身包含字面量 `----` 的组合凭据；批量导入每行使用以下一种格式：

```text
email----password----refresh_token----client_id
email----password----client_id----refresh_token
email--------refresh_token----client_id
```

- 四字段格式的最后两段可以互换；浏览器根据其中唯一的 UUID 自动识别 Client ID。两段都不是
  UUID 或两段都是 UUID 时会拒绝该行，避免猜测。
- 四字段中只要 refresh token 与 Client ID 齐全，就使用 OAuth2。用户确认后，组合里的 password
  会用独立 AAD 上下文执行 AES-GCM 加密，保存到 `combination_password_cipher`；它不会进入
  IMAP LOGIN，也不会作为 OAuth2 失败后的认证回退。
- 两字段 `email----password` 不再支持；前端与结构化 API 都会拒绝。
- 八个连续连字符表示 OAuth2 四字段格式中的 password 为空。
- 预览只显示规范化邮箱、识别模式和脱敏 Client ID，不显示密码或完整 token。
- 批量导入分为“输入账号”和“安全确认”两步；输入框高度固定，安全预览出现前不会上传凭据。
- 每批最多 25 个有效账号；浏览器逐项提交并显示真实验证进度。当前项会显示转圈，成功后显示
  对勾并从列表移出；失败项保留具体错误。用户/IP 验证窗口允许连续处理两批完整批次，超过后
  才限速。
- 若密码本身包含字面量 `----`，请改用 **分字段录入**，不要让解析器猜测字段位置。

## 4. 验证与收信

连接时 Worker 先试 Graph：真实 token 兑换 → `GET /me/mailFolders` → INBOX 状态；Graph 因认证或
权限被拒时再试 IMAP：token 兑换 → XOAUTH2 → `LIST` → INBOX `EXAMINE`。限流、超时等瞬时失败不会
触发换通道。任何一步失败都不会建立一个“看起来成功”的后台账号；两条通道都被拒绝时，导入结果
会按通道分别列出原因。

连接成功后：

- 后台约每 5 分钟同步一次 INBOX 元数据，每账号最多保留最近 500 条；
- 工作区可聚合全部账号 INBOX，或选择单账号与服务器返回的文件夹；
- 单次读取数量可选 25、50、100 或 200，服务端仍强制限制为 1–200；
- “全部 Microsoft”范围的同步按钮会为所有已连接账号逐个请求 INBOX Queue 同步；
- 单账号范围的“远程刷新”经当前通道只读地更新当前文件夹（Graph：`/me/mailFolders/{folder}/messages`
  按 `receivedDateTime` 倒序分页；IMAP：`EXAMINE`、`UID SEARCH`、`UID FETCH`）；
- 远端删除的邮件在下次同步时从本地索引移除；对账只在同一通道内比较，远端列表失败时跳过对账而
  不是清空索引；
- 正文和附件在打开时按需读取完整 MIME（Graph：`/me/messages/{id}/$value`；IMAP：`BODY.PEEK[]`）；
  正文读取成功后，未读邮件会先在远端标已读（Graph：`PATCH … {"isRead": true}`；IMAP：
  `UID STORE ... +FLAGS.SILENT (\Seen)`），成功后才更新本地；
- 已读写入失败不会阻断正文显示，重新打开可重试；Graph 因缺少 `Mail.ReadWrite` 返回 403 时，账号
  会被标为「权限不足」并暂停同步，替换凭据后恢复；移动、删除、归档、星标和其他写入均未开放；
- 删除连接只清理 OmniMail 本地密文与索引，不删除远端邮件。OAuth2 用户还应在 Microsoft
  账户或租户应用授权页面撤销不再使用的授权。

这是轮询式定时收信，不是 IMAP IDLE、Graph change notifications 或秒级推送。

## 5. 工作区操作

- 范围选择器默认是“全部 Microsoft”，聚合所有账号的 INBOX；选中账号后才显示其文件夹。
- 顶部复制按钮在全部范围复制第一个账号邮箱，单账号范围复制当前邮箱；范围面板中每个账号也有
  独立复制按钮。
- 全部范围使用“同步全部 Microsoft 账号”；单账号范围使用“远程刷新当前文件夹”。
- 账号管理支持修改备注、验证、同步、替换 OAuth2 凭据、单个断开和批量断开。
- 批量断开会逐个删除 OmniMail 本地记录，并显示当前进度；操作前需要二次确认。
- 连接、批量导入和账号管理共用稳定高度的响应式弹窗；内容过长时只在弹窗内部滚动。

## 6. 真实账号上线验收

代码测试使用受控协议响应，不包含任何真实凭据。正式启用前，请用一个专用 Outlook.com 测试
账号在部署后的工作区完成以下探针；整个过程不要截图、记录或复制 token 到日志：

1. OAuth2 导入成功，账号状态为“已连接”；
2. 文件夹列表可刷新，INBOX 可读取；
3. 能打开一封未读的纯文本或 HTML 邮件，并确认 Microsoft 端已标记为已读；
4. 能下载一个不超过 5 MiB 的测试附件；
5. 在全部范围触发同步，确认每个账号均进入 Queue；切换单账号后确认当前文件夹可远程刷新；
6. 顶部复制按钮和范围面板复制按钮只复制预期邮箱，不泄露其他凭据；
7. 手动同步入队后更新时间变化，下一次 Cron 同步不产生重复记录；
8. 撤销应用授权后，账号进入凭据或权限错误且不会无限重试；
9. 如需宣称 Microsoft 365 支持，再用受控工作/学校账号重复以上步骤。租户关闭 IMAP 时账号应
   经 Graph 正常导入并收信（这正是双通道要解决的场景）；`GET /api/microsoft/accounts` 响应中
   `preferredTransport` 会显示实际通道。

批量验收可用 `scripts/microsoft-graph-e2e.ps1`（PowerShell 7）对本地 `wrangler dev` 或已部署
Worker 跑一遍：逐行导入 → 列账号 → 每账号 `refresh=1` 列信 → 指定序号读正文并检查 `isRead`。
判据：导入全部 `accepted`；列信 HTTP 200 且 `messages` 是数组（**空数组是成功**，多数测试
邮箱本来没信）；有邮件的账号读正文非空且 `isRead: true`。脚本掩码邮箱、不打印任何 token；
Outlook 网页侧「已读」「删除后消失」两项仍需人眼确认。

OmniMail 不使用 ROPC、密码 LOGIN、网页登录自动化、代理或其他规避措施。

## 7. 安全边界与故障排查

- OAuth 主机、authority 形式、Graph origin、IMAP 主机和端口均由服务端白名单固定，导入数据不能
  指定 URL、主机或端口；Graph 分页链接必须同源，否则拒绝。
- 账号、文件夹、邮件和附件查询都同时校验当前用户归属；消息身份分两层：`internet_message_id`
  跨通道去重，`(source_transport, remote_id)` 通道内定位（IMAP 行另绑 UIDVALIDITY）。
- 唯一允许的远端写入是对精确定位的一封邮件标已读（Graph `PATCH isRead` / IMAP `\Seen`）；不接受
  客户端传入协议命令、flags、主机或端口；写操作不会跨通道重放。
- API 响应使用 `private, no-store`；审计只记录脱敏邮箱和认证模式。
- `transport_unavailable` 表示两条通道都被拒绝；响应里的 `attempts[]` 逐通道给出 `code` 与
  可读 `message`，先看它再决定下一步。
- `invalid_grant` 通常表示 refresh token 失效或被撤销；请重新授权并替换凭据。
- `graph_scope_missing` / `imap_scope_missing` 表示 token 不含对应通道的委托 scope。
- `graph_permission_denied` 通常是缺 `Mail.ReadWrite`（标已读被拒）或租户策略；账号会进入
  `permission_error`，替换凭据后恢复。
- `imap_access_rejected` 表示 IMAP 拒绝 OAuth2 登录（租户关闭 IMAP、缺少同意或条件访问阻止）；
  单独出现时说明 Graph 也未通过，看 `attempts[]` 里的 Graph 项。
- `graph_throttled` 表示 Microsoft 正在限流；响应带 `Retry-After`，Worker 不会在窗口内重试。
- `message_locator_stale` 表示这条索引来自另一条通道；刷新邮件列表后重试。
- `credential_decryption_failed` 表示部署密钥与保存凭据时不一致；恢复原
  `MICROSOFT_CREDENTIALS_KEY`，或断开后重新连接账号。

完整端点与响应说明见 [Microsoft API 参考](api/microsoft.md)。

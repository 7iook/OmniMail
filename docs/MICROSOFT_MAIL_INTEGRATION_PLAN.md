# Microsoft 邮箱当前实现说明

> 初始调研：2026-08-25
>
> 实现基线：2026-08-26，`feature/microsoft-mail-integration`（IMAP 单通道）
>
> 双通道基线：2026-09-02，`feat/microsoft-graph-channel`（Microsoft Graph + IMAP 级联）
>
> 状态：功能、测试和 Cloudflare Worker 部署链路已实现；本文只描述当前代码，不保留已取消方案。
> 「为什么这样设计、否决了哪些替代方案」见 [ADR 0001](architecture/0001-microsoft-transport-identity.md)。

## 1. 当前结论

OmniMail 已提供独立的 Microsoft 邮箱工作区，支持用户连接多个 Outlook.com、Hotmail、Live，
以及 Microsoft 365 委托式邮箱。当前实现只覆盖 Azure Global。

同一份 OAuth2 凭据（refresh token + Client ID）可以走两条传输通道，Worker 自动试探并回退：

```text
refresh token + Client ID
  -> Microsoft OAuth v2 token endpoint（按通道申请不同 scope）
  ├─ Graph 通道：access token -> https://graph.microsoft.com/v1.0（HTTPS）
  └─ IMAP  通道：access token -> outlook.office365.com:993 TLS -> IMAP SASL XOAUTH2
```

- 新导入的账号先试 Graph（真实凭据实测 20/20 可用，同一批号 IMAP 全被拒绝），失败再试 IMAP。
- 成功的通道记录到账号的 `preferred_transport`，之后的同步优先走它；该通道失效时试另一条，
  并有条件地改写记录（详见 §5.1）。
- 通道决议逻辑只存在于 `microsoft-session.ts` 的 `cascade()` 一处；导入、替换凭据、验证、
  定时同步、手动刷新、读正文全部经它取得传输实例。
- 租户关闭 IMAP 的 Microsoft 365 账号不再被拒绝：Graph 通道不依赖租户的 IMAP 开关。

仅邮箱密码导入、IMAP `LOGIN`、ROPC、网页登录自动化和 OAuth2 失败后的密码回退均已停用。
四字段组合中携带的 password 只可在用户明确确认后独立加密留存，不参与任何登录、验证、同步
或失败回退。

运行时不依赖第三方 Outlook 收件服务，不向第三方发送邮箱、令牌、密码或邮件内容；出站只到
`login.microsoftonline.com`、`graph.microsoft.com` 与 `outlook.office365.com:993`。

## 2. 已实现的产品能力

### 账号连接

- 分字段录入：账号名称、邮箱地址、refresh token、Client ID、authority 和可选组合密码。
- 批量导入：浏览器解析逐行文本，先安全预览，再逐账号验证并导入。
- 新账号保存前必须在任一通道真实完成 token 兑换、通道握手（Graph：`GET /me/mailFolders`；
  IMAP：XOAUTH2）、文件夹列举和 INBOX 状态读取。任何一步失败都不会建立「看起来成功」的账号。
- 两条通道都被拒绝时，该项返回 `code: transport_unavailable`，并附 `attempts[]` 按通道说明
  各自为何失败（见 §7.1）。
- 重复邮箱不会覆盖已有账号；每一项独立返回成功、重复或稳定错误。
- 组合密码存在时，安全预览页必须勾选允许服务端加密保存，之后才会上传。

### 账号管理

- 查看邮箱、脱敏 Client ID、连接状态和最近错误码；替换凭据表单会带入当前 authority。
- 修改本地备注名称。
- 重新验证当前凭据与邮箱权限（走级联；成功通道会写回 `preferred_transport`）。
- 手动把当前账号 INBOX 同步加入 Queue。
- 真实验证成功后替换 refresh token、Client ID 和 authority；替换会把通道记录重置后写入
  新凭据实际通过的通道。
- 单个断开，或进入批量管理后选择多个账号顺序断开。
- 断开只删除 OmniMail 本地凭据、文件夹和邮件索引；远端邮件及 Microsoft 应用授权不删除。

### 工作区

- “全部 Microsoft”聚合所有已连接账号的 INBOX 元数据。
- 选择单个账号后，可浏览服务器返回的文件夹（Graph：`/me/mailFolders`；IMAP：`LIST`）。
- 每页数量支持 25、50、100、200，服务端接受范围为 1–200，默认 50。
- 搜索发件人、收件人、抄送和主题；使用不透明游标分页。
- 顶部复制按钮在单账号范围复制当前邮箱，在全部范围复制账号列表中的第一个邮箱。
- 范围面板中每个账号也提供独立复制按钮，复制不会切换范围或关闭面板。
- 全部范围的同步按钮逐账号调用单账号同步接口，把所有账号 INBOX 加入 Queue。
- 单账号范围的刷新按钮直接受限刷新当前文件夹，然后重新读取本地元数据。
- 账号范围、文件夹、数量、管理入口和复制入口集中在范围面板与列表标题栏。
- 界面不显示也不允许选择通道：通道由服务端自动决议，用户无需也无法干预。

### 邮件读取

- 列表长期保存的只是有限元数据，不保存正文或附件内容。
- 打开邮件时按需获取完整 MIME 并解析纯文本、HTML、CID 图片和附件；两条通道喂同一个解析器：
  - Graph：`GET /me/messages/{id}/$value`
  - IMAP：`UID FETCH <uid> (BODY.PEEK[])`
- 正文成功读取后，如果本地记录仍为未读，先在远端写已读，成功后才更新本地 `is_read`：
  - Graph：`PATCH /me/messages/{id}` `{ "isRead": true }`（需要 `Mail.ReadWrite`）
  - IMAP：独立会话 `SELECT <validated-folder>` + `UID STORE <uid> +FLAGS.SILENT (\Seen)`
- 写入前重新校验用户、账号、文件夹；IMAP 行还校验 UIDVALIDITY；索引行的 `source_transport`
  与本次决议到的通道不一致时返回 409 `message_locator_stale`，提示刷新列表（见 §6.3）。
- 已读写入失败不会阻断正文响应，也不会把本地索引错误标记为已读。写操作遇到权限不足（Graph
  403 / 缺 `Mail.ReadWrite`）时**不会**换通道重放，而是把账号标为 `permission_error`，
  由用户重新授权；该状态会暂停该账号的定时与手动同步，直到凭据被替换。
- 附件按需重新读取 MIME，单个下载上限为 5 MiB；远程完整 MIME 响应上限为 10 MiB。
- 不提供发信、回复、删除、移动、归档、星标或除已读外的远端写入。

## 3. OAuth2 输入格式

页面分隔符是四个连字符 `----`，只支持以下两类 OAuth2 凭据。

### 完整组合

```text
email----password----refresh_token----client_id
email----password----client_id----refresh_token
```

最后两段允许互换。浏览器要求其中必须且只能有一段是合法 UUID，并把它识别为 Client ID；
另一段作为 refresh token。两段都像 UUID 或都不像 UUID 时拒绝，不猜测字段位置。

password 不参与认证。只有用户在安全预览页明确勾选保存许可后，它才会作为
`combination_password_cipher` 加密留存。

### 仅 OAuth2

```text
email--------refresh_token----client_id
```

八个连续连字符表示四字段中的 password 为空。该格式仍会被统一解析成 `authMode=oauth2`。

### 已停用格式

```text
email----password
```

前端解析器和结构化 API 都会拒绝该格式，并返回 `password_auth_removed` 或对应可读错误。

### 浏览器解析规则

1. 去掉每行 BOM、首尾空白和空行，不改写 token 或 password 内部字符。
2. 只接受恰好四字段；若 password 本身包含 `----`，要求改用分字段录入。
3. 邮箱转为小写后做基础格式校验。
4. Client ID 必须是 UUID；refresh token 必须非空。
5. 当前批次按规范化邮箱去重。
6. 预览只显示邮箱、OAuth2 模式、是否含组合密码和脱敏 Client ID。
7. refresh token、password 和完整 Client ID 不在预览中回显。
8. 一次页面批次最多 25 行；页面逐项向导入 API 提交，以显示真实进度和单项结果。

结构化 API 接收的模型为：

```json
{
  "name": "Work Outlook",
  "email": "owner@outlook.com",
  "authMode": "oauth2",
  "refreshToken": "<refresh-token>",
  "clientId": "00000000-0000-4000-8000-000000000000",
  "authority": "common",
  "password": "<optional-combination-password>",
  "persistPasswordConfirmed": true
}
```

`password` 不存在时不要发送 `persistPasswordConfirmed`。存在时该字段必须严格为 `true`。

## 4. OAuth 与网络边界

允许的 OAuth endpoint 只有：

```text
https://login.microsoftonline.com/{authority}/oauth2/v2.0/token
```

`authority` 只允许：

- `common`
- `consumers`
- `organizations`
- 合法 tenant UUID

### 4.1 按通道申请的 scope

token 请求固定 `grant_type=refresh_token`，scope 由通道决定（`microsoft-token.ts`
`SCOPE_REQUIREMENT`，单一定义；`microsoft-graph-scopes.ts` 只 re-export 并补充
「操作 → 所需权限」映射，用于把 403 翻译成可行动的提示）：

| 通道 | 请求 scope | 校验通过条件 | 缺失时错误码 |
| --- | --- | --- | --- |
| IMAP | `https://outlook.office.com/IMAP.AccessAsUser.All offline_access` | 回显含 `IMAP.AccessAsUser.All` | `imap_scope_missing` |
| Graph | `https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access` | 回显含 `Mail.Read` **或** `Mail.ReadWrite`（任一即可读） | `graph_scope_missing` |

- Graph scope 必须以 `https://graph.microsoft.com/` 完整限定：Outlook REST 资源也发布同名
  `Mail.Read`，那种 token 打不通 Graph。
- 只拿到 `Mail.Read` 的账号仍可列信、读正文，只是已读回写会被 Graph 拒绝（403 →
  `permission_error`）。Microsoft 未回显 scope 时视为已授予，由真实 403 说话，不预先拦截。
- 2026-09-01 用 20 个真实凭据实测：原本只为 IMAP 签发的 refresh token 可直接换取 Graph token，
  且 `Mail.ReadWrite` 全部授予，无需重新授权。

### 4.2 token 缓存

- 两通道的 access token **不可互换**（scope 不同）：IMAP token 存 `access_token_cipher`，
  Graph token 存 `graph_access_token_cipher`，各有独立过期时间与 AES-GCM AAD 上下文。
- refresh token 每账号一份，两通道共用。响应包含轮换后的 refresh token 时，服务端在账号级
  token lease 下原子替换旧密文。
- 有效 access token 会在过期前 60 秒内视为过期并刷新；IMAP OAuth 认证收到 400/401 时，只允许
  强制刷新并重试一次。

### 4.3 网络出口

- Graph 固定 `https://graph.microsoft.com/v1.0`；分页链接 `@odata.nextLink` 必须与该 origin
  相同，否则拒绝（`graph_invalid_next_link`），bearer token 不会被发往其他主机。
- IMAP 主机和端口固定为 `outlook.office365.com:993`，强制 TLS。
- 导入数据和 API 请求都不能指定 OAuth URL、Graph URL、IMAP 主机、端口、TLS 策略、代理或
  原始协议命令。

### 4.4 Graph 客户端实测事实（v1.0）

以下是接入时用真实邮箱测出的行为，代码已按此实现，后续修改前不必重查：

- `size` **不是** v1.0 `message` 的属性，`$select` 里带它整个请求被拒。消息大小只能经
  `$expand=singleValueExtendedProperties($filter=id eq 'Integer 0x0E08')` 取得；客户端提供
  `includeSize` 开关但当前传输层**未启用**，因此 Graph 行的 `size_bytes` 为 0。
- `wellKnownName` 是 beta-only 属性，`displayName` 是本地化文本（中文邮箱返回「收件箱」），
  所以 v1.0 的文件夹列表**无法认出**哪一项是收件箱。收件箱一律按 URL 里的 well-known name
  `inbox` 寻址，并在适配层归一为路径 `INBOX`，其它文件夹按 `displayName` 暴露。
- `$top` 是合法的页大小；`$skip` 会静默截断。分页只跟 `@odata.nextLink`，代码里没有
  `$skip` 算术。
- Graph 消息 ID 长约 140 字符、非纯数字，装不进 `INTEGER` 列。
- `contentId` 可从附件响应体读取，但不可 `$select`。
- 429 是契约不是故障：限流期间用量仍在累计，立即重试会延长锁定。客户端在 `request()` 内等待
  `Retry-After` 秒后再试（最多 3 次；服务端要求等待超过 60 秒时放弃本次调用并把秒数交给调度）。

## 5. 同步模型

### 5.1 通道决议与粘性

`microsoft_imap_accounts.preferred_transport` 是账号级路由状态，取值 `unknown | graph | imap`：

```text
      unknown（新导入 / 刚替换凭据）
          │ 先试 graph
   ┌──────┴───────┬─────────────────┐
   ▼              ▼                 ▼
graph 成功     graph 失败且        两者皆失败
   │           imap 成功              │
   ▼              ▼                   ▼
preferred      preferred          导入拒绝 / 同步失败
 =graph         =imap        （transport_unavailable + attempts[]）
   └──────┬───────┘
          ▼
  下次优先该通道；失败则试另一条；
  成功通道 ≠ 记录值 → 条件写回
```

- 写回是条件更新 `WHERE preferred_transport = <读到的旧值>`，两个并发同步不会互相覆盖；
  条件失配时静默放弃，不影响本次取信。
- **只有认证/授权类失败才允许换通道**。限流、超时、5xx、解析错误、邮件不存在都不换通道，
  也不改写粘性——否则限流窗口内会来回抖动。回退矩阵以数据形式写在
  `microsoft-transport-errors.ts`：

| 失败类别 | 典型错误码 | 读操作换通道 | 写操作（标已读）换通道 |
| --- | --- | --- | --- |
| `auth` | `invalid_grant`、`graph_credential_rejected`、`imap_access_rejected` | 是 | 是 |
| `permission` | `graph_permission_denied`、`graph_scope_missing`、`imap_scope_missing`、`xoauth2_unavailable`、`consent_required` | 是 | **否**，报 `permission_error` |
| `throttled` | `graph_throttled`、`validation_rate_limited` | 否 | 否 |
| `transient` | `graph_unavailable`、`graph_timeout`、`graph_listing_truncated`、`timeout`、`connection_failed`、`token_endpoint_unavailable` | 否 | 否 |
| `contract` | `graph_invalid_response`、`graph_invalid_folder`、`response_too_large`、`password_auth_removed` | 否 | 否 |
| `data` | `graph_message_not_found`、`remote_message_not_found` | 否 | 否 |

- 失败类别同时决定账号状态：`auth → credential_error`，`permission → permission_error`，
  其余 → `error`。`credential_error`/`permission_error` 会暂停定时与手动同步，直到替换凭据。

### 5.2 后台 INBOX 同步

- 新账号连接成功后尝试加入一次 `reason=connect` 的同步任务；Queue 失败时由 Cron 后续补偿。
- Cron 约每 5 分钟扫描 `active` 或可重试 `error` 账号，每批最多加入 50 个任务。
- Queue 消费者使用 6 分钟账号同步 lease，避免同一账号并发同步。
- 每次同步先列文件夹并落库（消息表对文件夹表有复合外键，Graph 邮箱在此之前没有任何文件夹
  行），再刷新 INBOX 最近 100 条元数据。
- 每个账号、每个文件夹、**每条通道**本地最多保留最近 500 条元数据；保留裁剪按通道分别进行，
  IMAP 同步不会淘汰 Graph 抓到的行，反之亦然。
- 只有 `transient`/`throttled` 类失败会让 Queue 重试（最多 3 次，30s 起指数退避）；被限流时
  重试延迟取 `max(退避, Retry-After)`，`next_sync_at` 取 `max(300s, Retry-After)`。
  `auth`/`permission` 失败把账号停 24 小时，凭据、权限、响应过大等不可重试错误直接确认任务。

### 5.3 删除对账

- 每次刷新文件夹时向当前通道要一份「远端仍存在的 ID 集合」（Graph：只 `$select=id` 的分页
  列表，每页 500、最多 20 页；IMAP：`UID SEARCH ALL`），本地有而远端没有的行被删除。
- 对账**严格按 `source_transport` 过滤**：只把本通道的本地行与本通道的远端集合比较。两条通道
  的 ID 空间不同，跨通道比较会把另一通道的每一行都误判为「远端已删」。
- 远端列表失败（限流、截断、瞬时错误）时**跳过本轮对账**，不删除任何行；「列表失败」从不被
  解读为「文件夹为空」。Graph 列表超出页预算会抛 `graph_listing_truncated` 而不是返回部分集合。
- IMAP 的 UIDVALIDITY 作为该通道的「定位纪元」：与上次存储值都非空且不同时，只清掉本通道在该
  文件夹的行后重建。Graph 没有纪元（恒 `null`），永远不会触发这条清除；文件夹行上的
  `uid_validity` 用 `COALESCE` 保住 IMAP 纪元，Graph 成为活跃通道期间不会把它抹掉。

### 5.4 手动同步

- `POST /api/microsoft/accounts/{id}/sync` 把指定账号 INBOX 加入 Queue。
- 单账号手动同步冷却为 60 秒。
- 工作区“全部 Microsoft”按钮在浏览器端并行调用每个账号的单账号同步接口，没有额外批量 API。
- 凭据或权限错误状态的账号需要先修复，不能继续手动入队。

### 5.5 当前文件夹刷新

- `GET /api/microsoft/messages?...&refresh=1` 要求同时传 `accountId`。
- 服务端经级联取得传输后直接刷新当前已验证文件夹，冷却为 30 秒。
- 后台定时同步仍只覆盖 INBOX；其他文件夹只在用户主动刷新时更新。
- 已知边界：非 INBOX 文件夹的路径在两条通道下可能不同（IMAP `Sent Items` vs Graph 本地化
  `displayName`），账号切换通道后刷新这类文件夹可能得到 404 `graph_invalid_folder`；本轮不做
  folder-id 映射列。

## 6. 数据与凭据

### 6.1 D1 迁移

- `0027_microsoft_imap.sql`
- `0028_microsoft_oauth_combination_password.sql`
- `0036_microsoft_transport_channel.sql`：账号表加 `preferred_transport`、
  `graph_access_token_cipher`、`graph_access_token_expires_at`；消息表重建为下节形状。
  该迁移在消息表非空时**主动失败中止**（`_migration_0036_guard`），不会静默丢数据。

同一 schema 还维护在 `email-worker/src/platform/d1/schema-migrations.ts`，由测试断言两处一致。

当前表：

- `microsoft_imap_accounts`
- `microsoft_imap_folders`
- `microsoft_imap_messages`
- `microsoft_imap_validation_limits`

### 6.2 三个「通道」字段不可混用

| 字段 | 表 | 含义 | 谁写 |
| --- | --- | --- | --- |
| `auth_mode` | accounts | 凭据类型 `oauth2 \| password`，与传输无关 | 导入时 |
| `preferred_transport` | accounts | 账号首选传输 `unknown \| graph \| imap`，粘性状态的唯一真源 | 通道成功后条件写回 |
| `source_transport` | messages | 该行是经哪条通道抓到的（消息级事实） | 落库时 |

`source_transport` 不得兼任 `preferred_transport`。

### 6.3 消息身份（两层）

```text
跨通道身份：internet_message_id（RFC5322 Message-ID，非空时）  → 去重
通道内定位：(source_transport, remote_id)                     → 取正文 / 标已读 / 删除对账
```

- `remote_id TEXT`：IMAP 存 UID 的字符串形式，Graph 存不透明 ID。**不可跨通道比较。**
- `uid_validity INTEGER` 可空：IMAP 行必须有，Graph 行必须为 `NULL`（表级 CHECK 强制）。
- 唯一约束两条并存：
  - `UNIQUE (account_id, folder_path, source_transport, remote_id)` —— 通道内唯一；
  - 部分唯一索引 `(account_id, internet_message_id) WHERE internet_message_id != ''` ——
    同一封信经两条通道各抓一次只留一行，粒度是账号级、不含 `folder_path`（两条通道对同一
    文件夹命名不同）。
- 落库用双路径 upsert：命中通道内定位键 → 原地刷新；命中 Message-ID 索引（同一封信从另一
  通道到达）→ 接管该行并改写 `source_transport`/`remote_id`/`uid_validity`，之后取正文和删除
  对账都经最后胜出的通道寻址。
- **承诺边界**：`internet_message_id` 为空的邮件不保证跨通道去重，通道切换后可能出现两行；
  这类行也无法被另一通道「认领」。
- 通道切换后、下一次刷新之前，旧通道的行被读取会得到 409 `message_locator_stale`；刷新后按
  Message-ID 重新认领即恢复。
- 邮件被移动到另一文件夹表现为「旧位置删除 + 新位置新增」，与 IMAP 时代行为一致。

### 6.4 兼容字段说明

`0027` 的表约束仍包含 `auth_mode=password` 与 `password_cipher`，用于旧迁移兼容；`0028` 会把
已有密码账号标为 `credential_error/password_auth_removed`，当前导入校验和级联都拒绝密码认证。
新账号只会写入 `auth_mode=oauth2`。

`microsoft_imap_folders.last_uid` 列保留但不再维护（恒 0）；它从未被读取。

四字段组合 password 使用 `combination_password_cipher`，与认证用凭据完全分离。

### 6.5 加密

部署 Secret `MICROSOFT_CREDENTIALS_KEY` 必须至少包含 32 个 UTF-8 字节。服务端先 SHA-256
派生 AES-GCM key，再用 12 字节随机 IV 加密。AAD 形式为：

```text
user_id:account_id:refresh-token
user_id:account_id:access-token
user_id:account_id:graph-access-token
user_id:account_id:combination-password
```

refresh token、两种短期 access token、组合 password 和密文都不会通过列表 API、日志、审计、
URL、公共缓存或导出接口返回。

## 7. HTTP API

当前共 11 个端点，没有为 Graph 新增端点：

| 方法 | 路径 | 当前用途 |
| --- | --- | --- |
| `GET` | `/api/microsoft/accounts` | 返回功能状态和当前用户的脱敏账号（含诊断用 `preferredTransport`） |
| `POST` | `/api/microsoft/accounts/import` | 独立验证并导入 1–25 个结构化 OAuth2 账号 |
| `PATCH` | `/api/microsoft/accounts/{id}` | 修改本地备注名称 |
| `PUT` | `/api/microsoft/accounts/{id}/credential` | 验证成功后替换 OAuth2 凭据 |
| `DELETE` | `/api/microsoft/accounts/{id}` | 删除本地凭据、文件夹和索引 |
| `POST` | `/api/microsoft/accounts/{id}/verify` | 经级联重新验证 token、通道和文件夹 |
| `POST` | `/api/microsoft/accounts/{id}/sync` | 受限加入该账号 INBOX 同步 |
| `GET` | `/api/microsoft/accounts/{id}/folders` | 读取缓存文件夹，可用 `refresh=1` 重新列举 |
| `GET` | `/api/microsoft/messages` | 聚合 INBOX 或读取单账号文件夹元数据 |
| `GET` | `/api/microsoft/accounts/{accountId}/messages/{messageId}` | 按需读取 MIME 并尝试同步已读 |
| `GET` | `/api/microsoft/accounts/{accountId}/messages/{messageId}/attachments/{partId}` | 按需下载附件 |

完整请求字段和 cURL 示例见 [Microsoft API 参考](api/microsoft.md)。

所有 JSON 响应使用 `Cache-Control: private, no-store`。资源查询始终联合校验当前 user ID、
account ID 和 message ID；不存在或不属于当前用户时返回相同的资源不存在边界。

消息元数据响应中 `uidValidity` 为 `null`、`remoteId` 为长字符串即表示该行来自 Graph；
前端不依赖这一区别。

### 7.1 错误响应

错误体固定为 `{ error, code }`，文案表在 `microsoft-api-shared.ts`（唯一真源，前端不重新翻译）。

- Microsoft 返回的 401 **不会**原样返回：前端把 401 视为 OmniMail 会话失效并登出，因此
  `auth` 类失败一律 400，`permission` 类 403，`throttled` 429（附 `Retry-After` 头），其余
  透传上游状态或 502。
- 两条通道都被拒绝（导入、替换凭据、验证、刷新文件夹）时返回：

```json
{
  "error": "Microsoft 邮箱的 Graph 与 IMAP 通道都无法连接。",
  "code": "transport_unavailable",
  "attempts": [
    { "transport": "graph", "category": "permission", "code": "graph_permission_denied", "status": 403, "message": "…" },
    { "transport": "imap", "category": "auth", "code": "imap_access_rejected", "status": 401, "message": "…" }
  ]
}
```

  `attempts[]` 每项为 `{ transport, category, code, status, message }`；`status` 是该通道
  失败的上游等价状态（可以是 401），`message` 是与单错误路径同一张表里的句子。批量导入的
  失败行把这些字段展开在结果项里。

- 常见错误码：

| 码 | 含义 |
| --- | --- |
| `transport_unavailable` | 两通道皆拒绝，看 `attempts[]` |
| `invalid_grant` / `invalid_client` | refresh token 失效、被撤销或与 Client ID 不匹配 |
| `graph_scope_missing` / `imap_scope_missing` | token 未授予该通道所需 scope |
| `graph_credential_rejected` / `imap_access_rejected` | 该通道拒绝了 access token |
| `graph_permission_denied` | Graph 403：通常是缺 `Mail.ReadWrite`（标已读）或租户策略 |
| `graph_throttled` | Graph 429；响应带 `Retry-After` |
| `graph_listing_truncated` | 列表超出页预算，本轮未完整读取（不会用部分集合对账） |
| `graph_invalid_folder` | 非 INBOX 文件夹无法经 Graph 定位（见 §5.5） |
| `message_locator_stale` | 索引行来自另一条通道，刷新列表后重试 |
| `message_identity_changed` | IMAP UIDVALIDITY 变化，刷新列表 |
| `validation_rate_limited` / `manual_sync_rate_limited` / `folder_refresh_rate_limited` | 我方自限流 |

## 8. 速率与安全限制

- 凭据导入、替换、重新验证和主动文件夹列举共用用户/IP 哈希验证窗口。
- 窗口为 10 分钟，允许 50 次，用于容纳两批 25 项导入。
- 手动账号同步冷却 60 秒；当前文件夹远程刷新冷却 30 秒。
- Graph 请求单次超时 20 秒，最多 3 次尝试；`Retry-After` 超过 60 秒时不在本次调用内等待。
- 账号名称最长 60 字符；refresh token 最长 16,384 字符；组合密码最长 1,024 字符。
- 查询关键词在服务端截断到 120 字符。
- 文件夹只能来自该账号已缓存的列举结果，不能由任意用户字符串直接选中；Graph 文件夹段只接受
  well-known name 或 `[A-Za-z0-9_\-=+]` 形式的不透明 ID。
- IMAP metadata 每批最多抓取 20 个 UID，并受协议响应和总执行时间限制；Graph 元数据每页最多
  100 条。
- HTML 使用现有沙箱与 CSP 渲染，下载响应使用安全文件名、`nosniff` 和 `private, no-store`。

## 9. 前端交互现状

- 连接/管理弹窗在桌面端统一使用最大 820px 的响应式固定高度，小屏使用 92dvh。
- 标题区固定，表单、账号列表和导入内容只在内部滚动；滚动条仅交互时显示。
- 弹窗打开使用淡入、上移和轻微缩放，关闭使用更快的反向动画，并尊重
  `prefers-reduced-motion`。
- 批量导入分为“输入账号”和“安全确认”两步；输入框占满预留区域且禁止拖动改变高度。
- 逐项导入时当前账号显示转圈，成功显示对勾后向右移出，其余账号平滑上移；预览框和操作按钮
  保持位置稳定。失败项按通道分别显示原因（来自 `attempts[]`）。
- 账号管理支持批量选择和二次确认断开；删除进度与结果通过可访问状态区域反馈。
- 图标按钮均有可访问名称；弹窗有焦点陷阱，关闭后恢复触发按钮焦点。

## 10. 当前代码位置

前端：

```text
src/features/microsoft/api/microsoft-api-client.ts
src/features/microsoft/components/MicrosoftWorkspace.tsx
src/features/microsoft/components/MicrosoftScopeSwitcher.tsx
src/features/microsoft/components/MicrosoftAccountDialog.tsx
src/features/microsoft/components/MicrosoftBatchImport.tsx
src/features/microsoft/components/MicrosoftReader.tsx
src/features/microsoft/model/microsoft-import.ts
src/features/microsoft/styles/microsoft-workspace.css
```

Worker：

```text
email-worker/src/features/microsoft/microsoft-routes.ts
email-worker/src/features/microsoft/microsoft-account-api.ts
email-worker/src/features/microsoft/microsoft-message-api.ts
email-worker/src/features/microsoft/microsoft-api-shared.ts        # 错误文案表 · 响应状态映射
email-worker/src/features/microsoft/microsoft-token.ts             # 按通道 scope 申请与校验
email-worker/src/features/microsoft/microsoft-token-manager.ts     # 按通道分列的 token 缓存 + lease
email-worker/src/features/microsoft/microsoft-graph-scopes.ts      # Graph scope 标识 · 操作→权限
email-worker/src/features/microsoft/microsoft-session.ts           # cascade()：唯一通道决议点
email-worker/src/features/microsoft/microsoft-transport.ts         # MicrosoftMailTransport 接口
email-worker/src/features/microsoft/microsoft-transport-errors.ts  # 失败分类 · 回退矩阵 · 状态映射
email-worker/src/features/microsoft/microsoft-graph.ts             # Graph 薄客户端（request() 单点）
email-worker/src/features/microsoft/microsoft-graph-transport.ts   # Graph 适配器
email-worker/src/features/microsoft/microsoft-imap.ts              # IMAP 客户端
email-worker/src/features/microsoft/microsoft-imap-transport.ts    # IMAP 适配器
email-worker/src/features/microsoft/microsoft-message-parser.ts    # MIME / Graph 元数据归一
email-worker/src/features/microsoft/microsoft-sync.ts              # 调度、lease、失败记录
email-worker/src/features/microsoft/microsoft-sync-folder.ts       # 文件夹刷新、双路径 upsert、删除对账
email-worker/src/features/microsoft/microsoft-store.ts
email-worker/src/features/microsoft/microsoft-credentials.ts
```

共用 IMAP 连接仍位于 `email-worker/src/platform/imap/`。Graph 不引入官方 SDK，客户端是仿
`icloud-apple.ts` 的自建薄封装。Microsoft 专有解析、状态和协议边界没有塞回 Gmail 或 iCloud 目录。

## 11. 测试与验收

仓库当前覆盖：

- OAuth2 token endpoint、按通道 scope 校验、轮换和 token lease；
- AES-GCM 上下文隔离（含 Graph token 独立 AAD）与密钥错误；
- OAuth2-only 输入校验和两种批量顺序；
- Graph 客户端：429 等待 `Retry-After` 后重试且不换通道、`nextLink` 跨页与 origin 校验、
  截断拒绝、`$select` 常量、PATCH isRead；
- 级联：`unknown` 先 Graph、粘性生效、只有 auth/permission 类失败换通道、条件写回不覆盖；
- 两通道对同一封信只落一行（Message-ID 去重）、空 Message-ID 退回通道内唯一；
- 删除对账只比较同通道行、列表失败跳过对账、UIDVALIDITY 变化只清本通道行；
- 已读回写先远端后本地、写 403 记 `permission_error` 且不换通道；
- XOAUTH2、LIST、EXAMINE、UID SEARCH/FETCH、MIME、附件和 `\Seen`；
- D1 迁移真实执行（含 0036）、用户隔离、唯一约束、同步 lease 和状态转换；
- 连接、替换、验证、同步、断开、`transport_unavailable` + `attempts[]` 和跨用户 API 边界；
- 批量导入两步流、逐项动画、按通道错误呈现、批量断开、范围复制、全部账号同步和移动端布局 E2E。

提交前使用：

```bash
npm test
npm run test:worker
npm run test:e2e -- e2e/microsoft-workspace.e2e.ts --workers=1
npm run build
```

自动化测试使用受控响应，不包含真实 Microsoft 凭据，**单测全绿不构成达标**。真实凭据验收用
`scripts/microsoft-graph-e2e.ps1` 对本地 `wrangler dev` 或已部署 Worker 跑一遍（判据见脚本
头部注释与 [Microsoft 邮箱设置指南](MICROSOFT_SETUP.md) §6）；已读回写与删除同步只能在有
邮件的账号上人工确认。

## 12. 当前明确不做

- Graph change notifications（Webhook）、delta 查询或秒级实时推送。
- 自动获取 refresh token、硬编码第三方 Client ID 或借用 Microsoft 第一方应用。
- ROPC、MFA/条件访问绕过、代理池或网页登录自动化。
- 仅邮箱密码、IMAP LOGIN 或 OAuth2 失败后的密码回退。
- shared mailbox、application permissions 或组织全邮箱抓取。
- Azure China、GCC High、DoD 等 national cloud。
- IMAP IDLE 或所有文件夹的后台持续同步。
- 界面上显示或选择通道；跨通道重放写操作。
- 长期保存正文、HTML、CID 图片或附件内容。
- 发信、回复、删除、移动、归档、星标或除已读外的远端写入。

## 13. 官方资料

- [Microsoft Graph 限流（429 / Retry-After）](https://learn.microsoft.com/en-us/graph/throttling)
- [Microsoft Graph 分页（@odata.nextLink）](https://learn.microsoft.com/en-us/graph/sdks/paging)
- [Microsoft Graph message 资源](https://learn.microsoft.com/en-us/graph/api/resources/message)
- [Microsoft IMAP/POP/SMTP OAuth 与 XOAUTH2](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
- [Microsoft refresh token 生命周期](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Microsoft OAuth 2.0 授权码流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

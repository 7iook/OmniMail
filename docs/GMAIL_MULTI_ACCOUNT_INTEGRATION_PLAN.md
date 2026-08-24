# Gmail 多账号聚合收件箱接入计划

- 状态：MVP 已在 `feat/gmail-multi-account` 实施，等待真实 Gmail 灰度验证
- 记录日期：2026-08-23
- 当前范围：Web 端多个 Gmail 账号的只读聚合查看；Android、扩展、OAuth 和发信仍不在范围内
- 主要接入方式：Gmail 应用专用密码 + IMAP over TLS
- 核心目标：同一个 OmniMail 用户连接自己的多个 Gmail 账号，并在一个网站中查看全部账号的最近来信

## 当前实施进度

已完成 D1 迁移、独立凭据加密、多账号 API、只读 Gmail IMAP 客户端、Queue/Cron 同步、
账号租约、UIDVALIDITY 与 Gmail 扩展字段索引、聚合列表、按需正文和附件、账号管理 UI、
部署自检、双语文案、API Catalog、单元/Worker/浏览器测试与部署文档。

尚未完成且不能由仓库测试替代的是：使用真实个人 Gmail / Workspace 测试账号，从实际部署的
Cloudflare Worker 验证登录、扩展字段、中文与多段 MIME、`BODY.PEEK[]` 不改变未读状态，以及
撤销应用密码后的稳定错误行为。在这些真实验证通过前，本功能不应标记为生产 Go-Live。

## 结论与推荐方向

OmniMail 是由用户自行部署的开源项目。不同部署实例具有不同域名，若使用 Gmail API OAuth，
每个部署者都需要创建 Google Cloud Project、OAuth Client 并配置自己的回调地址；共享一个
OAuth Client 还会让项目维护者成为集中授权服务的运营方。综合部署复杂度、自托管边界和仓库
现有 IMAP 能力，首版推荐使用：

> 用户为每个 Gmail 账号生成独立的应用专用密码，OmniMail 使用
> `imap.gmail.com:993` 直接 TLS 连接并提供只读聚合收件箱。

该方案不需要部署者申请 Google Cloud 服务，不需要 OAuth Client、Restricted Scope Verification、
Pub/Sub 或 CASA 安全评估。每个 Gmail 账号只需开启两步验证并生成一次应用专用密码。

首版提供独立的“Gmail”工作区，其中包含“全部 Gmail”和单账号筛选；不把 Gmail 邮件写入
OmniMail 当前的自有域邮箱 `messages` 表，也不与主收件箱、iCloud 或 Linux DO Mail 混合。

首版保持严格的产品只读边界：

- 只读取 INBOX 最近邮件、单封正文和用户主动下载的附件。
- 使用 `EXAMINE`、`BODY.PEEK[]` 等不会主动改变邮箱状态的命令。
- 不标记已读、不星标、不归档、不移动、不删除、不发送邮件。
- D1 只保存聚合列表所需的元数据；正文和附件按需读取，首版不持久化到 R2。

需要明确：应用专用密码本身并不是只读凭据。它没有 OAuth scope，理论上可以被用于 Gmail
允许的其他 IMAP/SMTP 操作。只读是 OmniMail 实现层的约束，因此必须对密码密文、连接命令、
账号隔离和日志脱敏采取严格保护。

## 成功标准

首版完成后应满足：

1. 一个 OmniMail 用户可以连接、重命名、重新验证和断开多个 Gmail 账号。
2. 用户能在“全部 Gmail”中按时间查看所有已连接账号的最近 INBOX 邮件。
3. 每封邮件能明确显示来源 Gmail 账号，并可按单账号筛选。
4. 用户可按需读取正文和下载受限大小的附件。
5. 应用专用密码不出现在 API 响应、浏览器持久化数据、日志或审计详情中。
6. 其他 OmniMail 用户无法读取账号记录、邮件元数据、正文或附件。
7. 同步失败只影响对应 Gmail 账号，不阻断其他账号和 OmniMail 主邮箱。
8. 整个功能不依赖 Google Cloud Project、OAuth Client 或项目维护者运营的中心服务。

## 前提假设与产品决策

本文按以下假设制定：

- 一个 OmniMail 用户连接的是自己有权访问的个人 Gmail 或 Google Workspace Gmail 账号。
- 首版的“全部邮箱”指全部已连接 Gmail 账号，不包含其他邮件提供方。
- Web 是首发端；Android 和浏览器扩展不随首版默认上线。
- 可接受定时轮询带来的分钟级延迟，不要求实时推送。
- 部署者已经配置可用于凭据加密的 Worker Secret。

实施前应确认以下决策；未确认时采用括号中的推荐默认值：

| 决策 | 推荐默认值 | 影响 |
| --- | --- | --- |
| 每个 OmniMail 用户的 Gmail 上限 | 5 个 | 控制连接、轮询和界面复杂度 |
| 首次索引范围 | 每账号 INBOX 最近 100 封 | 避免第一次连接下载大量历史邮件 |
| 定时同步间隔 | 5 分钟，按账号错峰 | 平衡更新延迟与 IMAP 连接数量 |
| 元数据保留范围 | 保持每账号最近 500 封 INBOX 索引 | 控制 D1 容量和对账开销 |
| 正文与附件缓存 | 不持久化 | 降低敏感数据和存储风险 |
| 打开邮件是否回写已读 | 不回写 | 保持首版只读和命令安全边界 |

如果真实需求是“把 OmniMail、Gmail、iCloud 和 Linux DO Mail 合成同一个总收件箱”，应在
本计划稳定后单独设计跨提供方数据模型和操作语义，不在 Gmail MVP 中顺带改造。

## 为什么首选应用专用密码 + IMAP

### 对自托管项目的优势

- 部署者无需进入 Google Cloud Console 创建项目和 OAuth Client。
- 不需要为每个不同的自托管域名登记 OAuth redirect URI。
- 不依赖 OmniMail 维护者运营 OAuth 中转服务，保持纯自托管边界。
- 不触发 Gmail Restricted Scope 的 OAuth 审核流程。
- Gmail 和 IMAP 本身不按 API quota 计费。
- 一个 Gmail 账号可生成一个仅用于 OmniMail 的独立密码，并可在 Google 账号中单独撤销。
- 仓库已经包含 iCloud 和 Linux DO Mail 的 Worker IMAP 实现，可复用经过验证的有限协议能力。

### 用户需要完成的操作

每个 Gmail 账号分别执行：

1. 在 Google 账号中启用两步验证。
2. 打开 Google“应用专用密码”页面。
3. 创建名称为 `OmniMail` 或包含部署实例名称的应用密码。
4. 将 Gmail 地址和生成的 16 位密码填写到自己的 OmniMail 实例。
5. OmniMail 验证 IMAP 登录成功后加密保存。

界面应允许用户粘贴带空格的应用密码，但服务端只移除显示分组使用的普通空格，不做其他猜测性
转换。密码只显示一次；保存后 API 仅返回 `hasAppPassword: true`。

个人 Gmail 自 2025 年起不再需要手动开启 IMAP，IMAP 访问默认启用。Google Workspace 账号
仍可能受到组织管理员策略限制。

## 已知限制与适用范围

### 部分账号无法创建应用专用密码

应用专用密码要求 Google 账号启用两步验证。以下账号可能没有该入口：

- 加入 Google Advanced Protection 的账号。
- 两步验证仅使用安全密钥的账号。
- 某些工作、学校或其他组织管理的 Google Workspace 账号。
- 管理员策略禁止应用专用密码或第三方 IMAP 的账号。

连接页面必须在用户填写密码前明确提示这些条件。对于无法创建应用密码的账号，首版不提供
绕过方式；后续可以把 Gmail API OAuth 作为可选兼容方案。

### 凭据权限较宽

应用专用密码不像 `gmail.readonly` 那样具有细粒度权限。即使 OmniMail 只发出只读命令，泄露
的凭据仍可能被其他客户端用于更广泛的邮件操作。该风险通过以下措施降低，但无法完全消除：

- 凭据只保存于用户自己的自托管实例。
- 每个 Gmail 账号使用独立、可撤销的应用密码，不使用 Google 主密码。
- 密码必须加密保存，解密范围限制在单次 Gmail 请求内。
- 首版代码层只允许固定的只读 IMAP 命令集合。
- 不开放任意 IMAP 主机、端口或原始命令接口。

### Google 不推荐把应用密码作为首选认证

Google 当前仍支持应用密码，但官方推荐支持“使用 Google 登录”的客户端使用 OAuth。应用密码
未来可能有策略变化，因此本方案要把“Google 停止或限制应用密码”记录为长期兼容风险。

首版上线前应使用真实个人 Gmail 和可获得的 Workspace 测试账号验证；每次大版本发布前重新
检查 Google 的应用密码和 IMAP 政策。

### 无 Gmail API 增量历史和推送

IMAP 没有 Gmail API 的 `historyId` 与 Pub/Sub 模型。OmniMail 需要自行维护 `UIDVALIDITY`、UID、
Flags 和 Gmail 扩展字段，并通过定时轮询达到最终一致。首版接受约 5 分钟更新延迟。

## 与其他方案的比较

| 方案 | 部署难度 | 能力 | 主要问题 | 结论 |
| --- | ---: | --- | --- | --- |
| 应用专用密码 + IMAP | 低 | 历史邮件、正文、附件、基础搜索 | 权限较宽；部分账号不可用；需要自行轮询 | 首版推荐 |
| Gmail API + 每部署 OAuth | 高 | 增量历史、标签、搜索、推送和细粒度权限 | 每个部署者配置 Google Cloud；公开使用涉及审核 | 后续可选 |
| OmniMail 官方 OAuth 中转 | 用户端低、维护端极高 | 可隐藏每部署 OAuth 配置 | 维护者接触授权并承担审核、安全评估和中心服务运维 | 不推荐 |
| Gmail 自动转发 | 低 | 接收开启后的新邮件 | 无历史、已读、标签和完整线程同步 | 可作为最简替代 |

## Gmail IMAP 协议设计

### 固定连接参数

- 主机：`imap.gmail.com`
- 端口：`993`
- 连接：直接 TLS
- 用户名：完整 Gmail 或 Google Workspace 邮箱地址
- 密码：用户生成的应用专用密码
- 服务器、端口和 TLS 模式不可由普通用户修改，避免 SSRF 和任意 TCP 代理能力。

首版连接序列建议为：

1. 建立有明确超时的直接 TLS socket。
2. 读取完整 greeting，并限制单行、总响应和等待时间。
3. 执行 `CAPABILITY`，确认基础 IMAP 和需要的 Gmail 扩展。
4. 执行带客户端名称、版本和联系地址的 `ID`。
5. 使用完整邮箱和应用专用密码认证。
6. 执行 `EXAMINE INBOX`，取得只读 mailbox 状态。
7. 完成受限的 `UID SEARCH` / `UID FETCH` 后主动 `LOGOUT` 并关闭 socket。

禁止把邮箱、搜索词或用户输入直接拼接为 IMAP 命令。所有字符串必须经过严格长度、字符和引用
处理；不支持 CR/LF、NUL 和无法安全编码的值。

### Gmail 扩展字段

Gmail 将标签映射为 IMAP 文件夹，同一封邮件可能出现在多个文件夹中。首版只同步 INBOX，仍应
保存 Gmail 提供的稳定标识，为以后扩展文件夹和线程做好最低限度的去重边界：

- `X-GM-MSGID`：Gmail 账号内跨文件夹稳定的邮件 ID，作为账号内去重主键。
- `X-GM-THRID`：Gmail 线程 ID，首版保存但不强制实现完整线程 UI。
- `X-GM-LABELS`：邮件当前 Gmail 标签，用于识别 Inbox、Unread、Starred 等展示状态。

所有这些 ID 都是 Gmail 账号作用域，数据库唯一约束必须包含 `account_id`，不能假设不同 Gmail
账号之间的 ID 全局唯一。

### 只读命令边界

首版允许的业务命令限定为：

- `CAPABILITY`
- `ID`
- 认证命令
- `EXAMINE INBOX`
- 受控的 `UID SEARCH`
- 受控的 `UID FETCH`
- `NOOP`（仅在单次请求连接内必要时使用）
- `LOGOUT`

读取正文使用 `BODY.PEEK[]` 或精确的 `BODY.PEEK[section]`，避免因为 FETCH 自动设置 `\Seen`。
首版禁止 `SELECT`、`STORE`、`COPY`、`MOVE`、`EXPUNGE`、`APPEND`、邮箱创建/重命名/删除及任意
原始命令透传。

## 同步策略

### 初始同步

连接验证成功后异步执行：

1. `EXAMINE INBOX` 并记录 `UIDVALIDITY`。
2. 搜索 INBOX 中最近的 UID，只选择最新 100 封。
3. 分小批 `UID FETCH`，取得：
   - `UID`
   - `X-GM-MSGID`
   - `X-GM-THRID`
   - `X-GM-LABELS`
   - `FLAGS`
   - `INTERNALDATE`
   - `RFC822.SIZE`
   - 列表所需的 From、To、Cc、Subject、Date、Message-ID 等 header
4. 解析并 upsert 到 D1 Gmail 元数据索引。
5. 保存本次看到的最高 UID 和成功同步时间。

初始同步只读取 header，不下载完整正文和附件。单次 FETCH 批量、响应 literal、邮件 header 和
总执行时间都必须有硬上限。

### 增量轮询

复用现有 Worker cron，以数据库时间条件筛选到期账号并错峰入队，而不是在 cron 请求中直接同步
所有账号。每个账号的同步任务：

1. 获取短时账号租约，已有有效租约时跳过，防止同账号并发连接。
2. `EXAMINE INBOX` 并检查 `UIDVALIDITY`。
3. 搜索高于 `last_seen_uid` 的新 UID，并读取元数据。
4. 对本地保留的最近消息分批刷新 `FLAGS` 和 `X-GM-LABELS`。
5. 服务端不再返回的已索引 UID 视为已移出 INBOX，从当前聚合索引中删除或标记移出。
6. 所有写入成功后才推进 `last_seen_uid` 和同步时间。

若 `UIDVALIDITY` 改变，清空该账号的 IMAP UID 映射并执行有限初始重建；不能继续使用旧 UID。
`X-GM-MSGID` 仍作为 Gmail 消息身份，但本地 INBOX 成员关系必须以本次 mailbox 状态为准。

首版只维护最近 500 封索引，因此 Flags 和移出 INBOX 对账也限制在该窗口内，不扫描整个邮箱。

### 正文与附件

- 用户打开邮件时，Worker 先验证 `account_id` 属于当前用户。
- 使用当前 IMAP UID 定位邮件；UID 失效时可用 `X-GM-MSGID` 搜索一次并修复映射。
- 通过 `BODY.PEEK[]` 按需读取完整 MIME，并复用现有安全解析和 HTML 清理。
- 设置单封原始邮件、解码正文、内嵌资源和附件的独立大小上限。
- 首版正文只在单次响应和前端内存缓存中存在，不写入 D1/R2。
- 附件由后端按需读取和转发；返回安全的 `Content-Type`、`Content-Disposition` 和文件名。
- 超大邮件或附件返回明确限制错误，不尝试无上限缓冲到 Worker 内存。

### 连接与错误控制

- 同一 Gmail 账号最多一个活跃同步连接；正文读取并发也应设置小上限。
- 使用连接、命令、literal 和总请求四层超时。
- 对临时网络错误使用有限指数退避；认证失败不自动高频重试。
- Gmail 返回连接过多时延长账号下次同步时间，避免形成重连风暴。
- 账号连续认证失败后置为 `credential_error`，等待用户更新应用密码。
- 一个账号失败不能阻断批次中的其他账号。

## 数据模型草案

以下只表达字段和约束，不是可直接执行的数据库迁移。

### `gmail_imap_accounts`

- `id`：OmniMail 内部账号 ID。
- `user_id`：所属 OmniMail 用户，所有查询必须带此条件。
- `name`：用户设置的展示名称。
- `email`：完整 Gmail 或 Workspace 邮箱地址。
- `app_password_cipher`：加密后的应用专用密码。
- `status`：`active`、`syncing`、`credential_error`、`error`。
- `uid_validity`：当前 INBOX 的 UIDVALIDITY。
- `last_seen_uid`：最后成功提交的最高 UID。
- `last_synced_at`、`next_sync_at`。
- `last_error_code`、`last_error_at`，不保存原始服务器敏感响应。
- `sync_lease_id`、`sync_lease_until`。
- `created_at`、`updated_at`。

建议在 `(user_id, email)` 上建立大小写不敏感唯一约束，避免同一 OmniMail 用户重复连接同一
Gmail 地址。不同 OmniMail 用户仍可各自连接自己有权使用的同一共享邮箱，权限以凭据和用户
归属独立隔离。

### `gmail_imap_messages`

- `id`：OmniMail 内部消息 ID。
- `account_id`：所属 Gmail 账号。
- `gmail_message_id`：`X-GM-MSGID`，与 `account_id` 组成唯一约束。
- `gmail_thread_id`：`X-GM-THRID`。
- `imap_uid`、`uid_validity`。
- `message_id_header`。
- `sender_name`、`sender_address`、`recipients_json`、`cc_json`。
- `subject`、`preview`。
- `internal_date`、`size_bytes`。
- `flags_json`、`labels_json`、`is_read`、`is_starred`、`has_attachments`。
- `created_at`、`updated_at`。

首版不保存原始 MIME、正文、内嵌图片或附件。断开 Gmail 账号时级联删除该账号的全部元数据。
跨账号分页使用 `(internal_date, id)` keyset cursor，避免在多个实时 IMAP 连接间合并远程游标。

## 凭据安全设计

### 加密与密钥

- 新增独立的 `GMAIL_CREDENTIALS_KEY`，至少 32 字节，不与 iCloud 或 Linux DO Mail 共用。
- 应用密码使用 AES-GCM 加密，附加数据绑定 `user_id:account_id:app-password`。
- 密钥仅存在于 Worker Secret，不写入 D1、前端配置、日志或仓库。
- API 列表只返回是否已配置密码，不返回密文或任何可逆片段。
- 解密后的密码只在建立该账号单次 IMAP 连接的局部作用域内使用，不放入全局缓存。

### 添加、更新与删除

- 添加账号必须先用提交的邮箱和密码完成真实 IMAP 登录验证，成功后才保存密文。
- 更新应用密码时先验证新密码；验证失败保留原密文，避免一次输入错误破坏可用连接。
- 删除账号时立即删除本地密文、元数据和待处理同步任务。
- OmniMail 无法通过 IMAP 远程撤销 Google 应用密码。删除完成页必须明确提醒用户前往 Google
  账号的应用密码页面手动移除对应密码，不能显示“已撤销 Google 授权”。
- OmniMail 用户删除账号时采用相同清理流程，并在删除确认前提示远程密码需由用户手动撤销。

### 防滥用与日志

- 添加/验证/更新凭据接口按用户和 IP 限速，避免把 OmniMail 变成 Gmail 密码试探工具。
- 固定 Gmail 主机和端口，不接受用户提供的服务器 URL、代理或证书策略。
- 日志禁止出现邮箱密码、完整 IMAP 命令、原始 MIME、主题、正文和附件名。
- 审计日志只记录内部账号 ID、脱敏邮箱、动作、结果和稳定错误码。
- 对远程 IMAP 响应做长度限制和错误归一化，不把 Google 原始响应无条件返回浏览器。

## MVP 用户体验

### 添加账号

添加弹窗分成两步：

1. 显示创建应用专用密码的条件、Google 官方入口和简短操作说明。
2. 填写账号名称、完整邮箱地址和应用专用密码，并执行连接验证。

提示文案必须包含：

- 这不是 Google 主密码，请勿填写主密码。
- 应用密码需要提前开启两步验证。
- 某些 Workspace 和 Advanced Protection 账号不支持。
- 凭据加密保存在当前用户自己的 OmniMail 部署中。
- 删除 OmniMail 账号连接后，仍需在 Google 账号中手动撤销该应用密码。

### 聚合收件箱

- 提供“全部 Gmail”和每个账号入口。
- 默认按 `INTERNALDATE` 跨账号倒序排列。
- 每封邮件显示账号颜色/名称、发件人、主题、摘要、时间、未读和附件标识。
- 切换单账号时保持相同列表和分页语义。
- 首版只显示 INBOX，不显示 All Mail、Sent、Spam、Trash 和自定义标签文件夹。
- 打开邮件不会回写 Gmail 已读状态，界面需明确避免造成错误预期。
- 账号同步失败时显示账号级状态，其他账号邮件仍可浏览。

### 账号管理

- 支持修改展示名称、手动同步、验证连接、更新应用密码和删除连接。
- 显示最后成功同步时间和稳定错误提示。
- `credential_error` 提供“更新应用密码”入口。
- 删除确认同时说明本地数据清理与 Google 端手动撤销的差异。

## API 草案

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/gmail/accounts` | 列出当前用户的 Gmail 账号和同步状态，不返回凭据 |
| `POST /api/gmail/accounts` | 验证 IMAP 后添加账号并加密保存应用密码 |
| `PATCH /api/gmail/accounts/{id}` | 修改账号展示名称 |
| `PUT /api/gmail/accounts/{id}/app-password` | 验证成功后替换应用密码 |
| `DELETE /api/gmail/accounts/{id}` | 删除本地凭据、账号和元数据 |
| `POST /api/gmail/accounts/{id}/sync` | 用户触发受限手动同步，带频率限制 |
| `GET /api/gmail/messages` | 按全部账号或单账号读取聚合列表并做 keyset 分页 |
| `GET /api/gmail/accounts/{id}/messages/{messageId}` | 按需读取并安全解析单封正文 |
| `GET /api/gmail/accounts/{id}/messages/{messageId}/attachments/{partId}` | 按需读取附件 |

所有包含账号或邮件 ID 的接口必须先以 `user_id` 验证账号归属。不要先按全局消息 ID读取后再
判断归属，避免跨用户存在性泄露。

## 与现有 OmniMail 的实现边界

当前 `messages` 表通过 `mailbox_address` 关联 OmniMail 管理的自有域邮箱，而且文件夹模型与
Gmail 标签并不相同。首版新增 Gmail 专用账号和索引表，使用独立 API 和工作区。

可复用的现有能力：

- 用户会话、API 权限校验和审计日志。
- iCloud 凭据的 AES-GCM 加密模式，但使用独立 Gmail 密钥和密文上下文。
- `email-worker/src/icloud-imap.ts` 的 Worker socket、有限响应解析和 MIME 读取经验。
- `email-worker/src/linux-do-mail-imap.ts` 的固定 IMAP provider 边界。
- Cloudflare Queue、定时任务、D1、邮件 HTML 清理和远程图片策略。

实现时只提取 Gmail 与现有 provider 确实共用的最小 IMAP 读写能力，不顺带重构 iCloud 或
Linux DO Mail。如果复用会导致大范围改动，允许 Gmail 先保留小型专用客户端。

## 分阶段实施与验收

### 阶段 0：真实 Gmail 协议验证

在写业务功能前完成最小、可删除且不保存凭据的验证：

- 从实际部署的 Cloudflare Worker 连接 `imap.gmail.com:993`。
- 使用专门测试账号的应用密码完成登录。
- 验证 `CAPABILITY`、`ID`、`EXAMINE INBOX`、受限 `UID SEARCH` 和 `UID FETCH`。
- 验证 `X-GM-MSGID`、`X-GM-THRID`、`X-GM-LABELS`、中文 header 和多段 MIME。
- 验证 `BODY.PEEK[]` 不会把未读邮件标为已读。
- 撤销应用密码后确认新连接失败，并记录 Gmail 返回的稳定错误类型。
- 如能获得 Workspace 测试账号，确认管理员允许和禁止应用密码时的行为。

验收条件：实际 Worker 中个人 Gmail 登录、有限列表和正文读取稳定成功；撤销密码后认证立即或
在合理时间内失败；首版所需 Gmail 扩展存在。任一关键条件不成立时停止实施并记录结果。

### 阶段 1：多账号与凭据边界

计划工作：

- 增加 Gmail 账号表、独立凭据密钥检查和加解密能力。
- 实现添加、列表、重命名、更新密码、验证和删除 API。
- 固定 Gmail host/port，补齐用户归属、限速、错误归一化和审计。
- 增加 Gmail 工作区入口和账号管理空状态，不实现邮件聚合列表。

验收条件：同一用户可连接至少两个 Gmail，其他用户不可访问；错误密码不会落库；更新失败保留
旧密文；所有响应和日志均不暴露密码。

### 阶段 2：元数据索引与定时同步

计划工作：

- 增加 Gmail 消息元数据索引和跨账号 keyset cursor。
- 实现有限初始同步、Queue 消费、账号租约和 cron 错峰轮询。
- 实现 UIDVALIDITY、last UID、新邮件、Flags/标签刷新和最近窗口移出 INBOX 对账。
- 覆盖重复同步、并发租约、分页中途失败、断连、超时、连接过多和凭据失效。

验收条件：两个 Gmail 同时收到新邮件后均能在预期轮询窗口内进入索引；重复任务不产生重复
记录；失败不会错误推进游标；移动出 INBOX 的近期邮件最终从聚合列表消失。

### 阶段 3：统一收件箱与按需正文

计划工作：

- 实现“全部 Gmail”、单账号筛选、稳定分页、账号徽标和同步状态。
- 实现 `BODY.PEEK[]` 正文读取、安全 MIME 解析、HTML 清理和附件受限代理。
- 增加加载、空状态、部分账号失败、密码失效和超大邮件提示。
- 完成响应式 Web 与键盘/屏幕阅读器检查。

验收条件：用户在一个页面中可区分并查看多个 Gmail 最近邮件；排序和翻页无明显重复或漏项；
打开邮件不改变 Gmail 未读状态；正文和附件不引入 XSS、越权或凭据泄露。

### 阶段 4：生产加固与文档

计划工作：

- 增加功能开关、账号上限、同步配额、部署自检和非敏感可观测性。
- 编写面向部署者和普通用户的应用密码创建、更新、撤销及常见错误说明。
- 使用多个真实个人 Gmail 小规模灰度，并尽可能覆盖 Workspace 行为。
- 重新核对 Google 当时的应用密码和 IMAP 政策后发布。

验收条件：连续灰度期间没有跨用户数据泄露、连接风暴或不可恢复索引错误；部署和账号连接说明
可由未接触 Google Cloud Console 的普通用户独立完成。

## 测试计划

### 单元测试

- 应用密码规范化、长度限制、禁止主密码误导和输入校验。
- Gmail 凭据加密、密文上下文隔离、错误密文和密钥缺失。
- IMAP 字符串引用、CRLF/NUL 注入拒绝、tag 和 literal 解析上限。
- Gmail header、地址、编码主题、X-GM ID、Flags、标签和附件元数据解析。
- UIDVALIDITY 变化、增量 UID、最近窗口对账和跨账号 cursor。

### Worker 集成测试

- D1 迁移、唯一约束、账号级联删除和用户隔离。
- 添加/更新先验证再保存，错误密码不覆盖原密文。
- 初始同步、重复任务、租约竞争、部分写入失败和游标原子推进。
- 超时、断连、认证失败、连接过多、畸形响应和超大 literal。
- 正文与附件 API 的 IDOR、大小、类型、超时和日志脱敏。

### Web E2E

- 添加两个账号、重复添加、更新密码、切换账号和删除连接。
- 全部账号排序、翻页、空状态、单账号失效和手动同步限速。
- 打开纯文本、HTML、多段 MIME、内嵌图片和附件邮件。
- 删除后的 Google 端手动撤销提示。
- 窄屏、键盘操作、焦点恢复和错误提示。

### 真实账号验证

- 至少两个个人 Gmail；如可获得，再增加一个允许应用密码的 Workspace 账号。
- 新邮件、未读、星标、移出 INBOX、删除、超大邮件和附件。
- Google 主密码变更及应用密码手动撤销后的连接状态。
- 暂停 cron 后恢复，确认有限索引可追平新邮件。
- 断开账号和删除 OmniMail 用户后检查 D1、Queue、日志和内存缓存残留。

## 可观测性与运维

只记录不含邮件内容和凭据的聚合指标：

- 已连接 Gmail 账号数及各状态数量。
- 初始同步耗时、增量同步延迟和每账号新增元数据数量。
- 认证失败、连接超时、连接过多、解析失败和超大邮件数量。
- Queue 等待时间、重试、死信和账号租约冲突数量。
- 距上次成功同步超过 15/30/60 分钟的账号数量。
- 单账号连接频率和异常请求峰值。

告警至少覆盖：大量账号同时认证失败、队列持续堆积、同步延迟升高、Gmail 连接错误突增和解析
失败在新类型邮件中集中出现。

## 预计工作量

在现有 iCloud/Linux DO IMAP、D1、Queue 和邮件渲染能力可有限复用的前提下：

| 阶段 | 粗估 |
| --- | ---: |
| 阶段 0：真实 Gmail 协议验证 | 1–2 个工程日 |
| 阶段 1：账号与凭据边界 | 2–4 个工程日 |
| 阶段 2：索引与定时同步 | 4–7 个工程日 |
| 阶段 3：聚合 UI、正文和附件 | 4–6 个工程日 |
| 阶段 4：测试、加固与文档 | 3–5 个工程日 |
| 合计 | 14–24 个工程日 |

该估算不包含 OAuth 兼容模式、发信、Android、浏览器扩展和跨提供方统一收件箱。Google 侧不
需要购买 Gmail API 服务或 OAuth 审核；部署者仍承担自己的 Worker/D1/Queue 使用成本。

## 暂不纳入 MVP

- Gmail API、Google OAuth、Pub/Sub 和中心 OAuth 中转服务。
- 无法创建应用专用密码账号的兼容接入。
- Gmail 全历史同步和完整离线镜像。
- 与 OmniMail 自有域、iCloud、Linux DO Mail 混合成一个总收件箱。
- 已读回写、星标、归档、移动标签、删除和垃圾邮件操作。
- SMTP 发信、草稿、回复、转发和 Send As 别名。
- All Mail、Sent、Spam、Trash、自定义标签树和完整 Gmail 搜索语法。
- 联系人、日历、Google Drive 或其他 Google 服务。
- Android、浏览器扩展和团队共享邮箱。
- 任意 IMAP 服务商配置；本计划固定 Gmail IMAP。

## 主要风险

- Google 将来可能进一步限制或停止应用专用密码，届时需要迁移到 OAuth。
- Advanced Protection、部分 Workspace 和管理员限制账号无法使用该方案。
- 应用密码不具备只读 scope，部署实例或加密密钥泄露会造成较高邮箱风险。
- IMAP 没有 Gmail API 的历史游标和推送，Flags 与移出 INBOX 只能依靠轮询最终一致。
- 大量账号在同一时间同步可能形成连接尖峰，必须设置账号上限、错峰和账号租约。
- Gmail 标签是多对多模型，未来扩展文件夹时可能出现重复邮件和操作语义问题。
- 邮件 HTML、远程图片和附件是不可信输入，复用现有渲染能力仍需完成 Gmail MIME 覆盖测试。
- Worker socket、内存和执行时间限制可能影响超大邮件，必须保持有限读取和明确上限。

## Go / No-Go 检查点

进入生产灰度前必须全部满足：

- 已确认接受“应用密码权限较宽”这一安全权衡。
- 已确认首版只支持能够创建应用专用密码的账号。
- 真实个人 Gmail 在实际 Worker 中完成登录、列表、正文和撤销验证。
- 已验证 `BODY.PEEK[]` 不会回写已读状态。
- 已确认每用户账号上限、同步间隔、索引窗口和正文不持久化策略。
- 已批准用户删除连接后仍需手动到 Google 撤销应用密码的交互说明。

任一项未满足时，可以保留本地实现和自动化测试，但不能开启生产灰度或宣称真实 Gmail 验收完成。

## 官方资料与仓库参考

- [Google 应用专用密码说明](https://support.google.com/accounts/answer/185833)
- [在其他邮件客户端中添加 Gmail](https://support.google.com/mail/answer/75726)
- [Gmail IMAP 扩展](https://developers.google.com/workspace/gmail/imap/imap-extensions)
- [Gmail IMAP 客户端建议](https://support.google.com/mail/answer/78892)
- [Google Advanced Protection 与应用密码限制](https://support.google.com/accounts/answer/7539956)
- [`LINUX_DO_MAIL_INTEGRATION_PLAN.md`](LINUX_DO_MAIL_INTEGRATION_PLAN.md)
- [`../email-worker/src/icloud-imap.ts`](../email-worker/src/icloud-imap.ts)
- [`../email-worker/src/linux-do-mail-imap.ts`](../email-worker/src/linux-do-mail-imap.ts)
- [`API.md`](API.md)

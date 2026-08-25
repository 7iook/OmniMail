# Microsoft 邮箱导入与 IMAP 收信实施计划

> 调研日期：2026-08-25
>
> 状态：已在 `feature/microsoft-mail-integration` 实现；受控真实账号协议探针与生产验收待执行
>
> 需求参照：[Nerver Outlook 收件箱](https://cha.nerver.cc/inbox) 与
> [Nerver API 文档](https://cha.nerver.cc/api)
>
> 范围：Outlook.com、Hotmail、Live，以及目标租户允许 IMAP 的 Microsoft 365 委托式账号

> 第三方边界：Nerver 页面和 API 文档只用于确认输入格式与产品行为，不作为运行时依赖。
> OmniMail 不调用 `cha.nerver.cc` 的任何接口，也不向该站点发送邮箱、密码、令牌或邮件内容。

## 结论先行

用户展示的页面并不是三套收信协议，而是 **三种凭据输入格式、两种 IMAP 认证方式**。
OmniMail 可以实现这些能力，首期主路径应调整为：

1. 兼容页面展示的三种逐行导入格式；
2. 有 `refresh_token + client_id` 时，通过 Microsoft OAuth 端点换取 access token；
3. 使用 IMAP SASL XOAUTH2 连接 Microsoft 邮箱；
4. 只有密码时，只有在用户明确选择兼容模式后才尝试 IMAP LOGIN；
5. 通过 IMAP `LIST`、`SELECT`、`UID SEARCH` 和 `UID FETCH` 实现文件夹、邮件列表、正文和附件；
6. 复用现有 Cron + Queue，每约 5 分钟拉取新邮件，并提供手动刷新；
7. 不把“实时”描述成秒级推送，首期不实现后台常驻 IMAP IDLE。

Microsoft Graph 不再作为完成本需求的首期前置条件。它可以作为以后面向 Graph token、租户关闭
IMAP 或需要 Microsoft 原生能力时的独立扩展，但不能阻塞用户现有 IMAP OAuth2 令牌的导入。

整个功能由 OmniMail 自己实现：前端自行解析导入文本，Worker 自行访问 Microsoft OAuth 官方
端点、建立到 Microsoft 官方 IMAP 主机的 TLS 连接、执行 XOAUTH2/LOGIN、解析 IMAP 响应与
MIME 邮件，并把必要的账号状态和有限邮件元数据保存到自己的 D1。部署和收信不需要 Nerver
服务在线，也不使用其 API、Cookie、代码或服务器。

## 需求边界与成功标准

本计划把“导入微软邮箱账号令牌啥的可以收取邮件”解释为：

- 用户可以导入自己有权访问的 Microsoft 邮箱；
- 单账号和批量粘贴均支持截图中的三种格式；
- OAuth2 账号可以自动刷新 access token，持续收信；
- 密码账号仅作为兼容能力，明确提示 Microsoft 可能拒绝 Basic Auth；
- 可以列出服务器文件夹、选择文件夹、指定 1～200 封的拉取数量；
- 可以查看邮件元数据、正文、HTML、CID 图片和附件；
- 默认同步 Inbox，用户选择的其他文件夹按同一套 UID 规则读取；
- 首期只读，不包含发信、删除、移动、归档或修改远端已读状态；
- 首期只支持 Azure Global，不同时扩展中国区、GCC High 或 DoD 云端点。

只有当 OAuth2 和密码兼容模式的能力、限制与错误都被明确展示时，才能声称“三种导入格式均已
支持”。仅仅把文本解析成功，但不能完成真实登录和收信，不算完成。

## 三种导入格式

页面展示的分隔符是四个连字符 `----`，必须支持以下三种格式：

### 1. 完整组合

```text
email----password----refresh_token----client_id
```

用途：兼容同时包含密码和 OAuth2 凭据的账号组合。

认证规则：只要 `refresh_token` 和 `client_id` 同时存在，就选择 OAuth2。不得在 OAuth2 验证
失败后静默降级为密码登录。默认丢弃密码；只有用户另外明确选择“保存密码兼容凭据”，才允许
保存密码。

### 2. 仅密码

```text
email----password
```

用途：尝试账号密码或应用专用密码的 IMAP 登录。

认证规则：导入预览必须标记为“密码兼容模式”，提示现代 Microsoft 账号通常要求 OAuth2，
服务器可能拒绝 Basic Auth。用户确认持久同步后，密码才可加密上传和保存；否则只允许一次性
连接验证，不建立后台同步账号。

### 3. 仅 OAuth2

```text
email--------refresh_token----client_id
```

这里 `email` 与 `refresh_token` 中间的八个连字符，表示四字段格式中的 password 为空：

```text
email----<empty-password>----refresh_token----client_id
```

这是首期推荐格式，认证方式为 OAuth2 + IMAP XOAUTH2。

### 结构化后的统一模型

浏览器把逐行文本解析为结构化字段，服务端不接收未解析的整段文本：

```json
{
  "email": "user@outlook.com",
  "authMode": "oauth2",
  "password": null,
  "refreshToken": "<refresh-token>",
  "clientId": "00000000-0000-0000-0000-000000000000",
  "authority": "common"
}
```

`authMode` 只允许 `oauth2` 或 `password`。不能由服务端根据一次登录失败自动切换认证方式。

### 解析与校验规则

每一行独立解析、独立报错，规则如下：

1. 去除行首 BOM、首尾空白和空行，不修改 token 或密码内部字符；
2. 接受恰好两字段的密码格式，或恰好四字段的完整/OAuth2 格式；
3. `email` 必填且必须通过基础邮箱格式校验；
4. 两字段格式要求 password 非空；
5. 四字段格式要求 `refresh_token` 和 `client_id` 同时非空；
6. `client_id` 必须是合法 UUID；
7. 四字段格式的 password 可以为空；
8. 出现多余字段、缺少 OAuth2 配对字段或无法判断时拒绝该行，不猜测字段位置；
9. 密码包含字面量 `----` 时逐行格式存在歧义，提示用户改用分字段表单；
10. 按规范化邮箱在当前批次去重，但最终仍以真实登录结果确认账号身份。

服务端最终校验条件为：

```text
email 必填
并且满足以下任意一种：
1. authMode=password 且 password 存在
2. authMode=oauth2 且 refresh_token、client_id 同时存在
```

### 导入预览

提交前逐行展示：

- 规范化邮箱；
- 检测到的模式：`OAuth2`、`密码兼容` 或 `OAuth2（组合中含密码）`；
- Client ID 的脱敏值；
- 是否会上传/保存密码；
- `待导入`、`重复` 或具体格式错误。

完整 refresh token 和密码永不回显。批量提交按小批次发送，每行返回 `accepted`、`duplicate`
或稳定错误，不能因为一行失败回滚整批。

## 两种认证方式

### OAuth2 + IMAP XOAUTH2（正式支持）

首期正式支持公共客户端签发、可使用 `client_id + refresh_token` 刷新的委托式令牌。

连接流程：

1. 使用固定 Microsoft OAuth token endpoint 兑换 access token；
2. 请求或验证 Outlook IMAP 权限
   `https://outlook.office.com/IMAP.AccessAsUser.All` 与 `offline_access`；
3. 如果响应包含新的 refresh token，原子替换旧值；
4. 使用固定 `outlook.office365.com:993` 和 TLS 建立 IMAP 连接；
5. 发送 SASL XOAUTH2 认证串：
   `base64("user=" + email + "\x01auth=Bearer " + accessToken + "\x01\x01")`；
6. 认证成功后列出文件夹或读取邮件；
7. 401、`invalid_grant`、权限不足和租户禁用 IMAP 必须区分为稳定错误。

实施前要用一份脱敏后的真实 token bundle 做协议探针，确认：

- refresh token 与 client ID 配套；
- authority 是 `common`、`consumers`、`organizations` 还是具体 tenant；
- token 可以换取 Outlook IMAP scope 的 access token；
- 个人账号和目标 Microsoft 365 租户是否允许 IMAP。

不接受只有短期 access token、没有 refresh token 的账号作为持续同步账号，也不硬编码第三方项目
或 Microsoft 第一方应用的 Client ID。

### 密码 IMAP LOGIN（显式兼容）

密码模式技术上可以复用现有 `ImapConnection.open(username, password)`，但产品上必须与
OAuth2 区分：

- 不承诺普通 Microsoft 账号密码一定可用；
- 不自动绕过 MFA、条件访问或租户策略；
- 不使用 ROPC 获取 token；
- 不在 OAuth2 失败后静默尝试密码；
- 建立持续同步前必须明确征得保存加密密码的确认；
- 密码变化或 Basic Auth 被关闭时，账号进入稳定的 `credential_error` 状态。

如果真实环境验证表明 Outlook 目标账号全部拒绝 LOGIN，保留格式解析和明确错误即可，不应为了
“看起来支持”而引入代理、自动化登录或规避 Microsoft 安全策略。

## 当前 OmniMail 可复用能力

仓库已经具备接近目标的 Gmail IMAP 聚合链路：

- `gmail_imap_accounts` / `gmail_imap_messages` 保存账号状态和有限元数据；
- AES-GCM 加密凭据，并使用账号上下文作为 AAD；
- 5 分钟 Cron 把到期账号放入 `MAIL_QUEUE`；
- Queue 使用同步租约，避免同一账号重复执行；
- 首次索引有限历史，D1 每账号最多保留有限数量元数据；
- 正文和附件按需远程读取，不在 D1/R2 长期保存；
- API、审计、用户隔离、手动同步限速和错误状态已有完整形态；
- `postal-mime` 已能处理正文、HTML、CID 图片和附件。

需要新增或调整的部分：

- 为 `ImapConnection` 增加独立 `openOAuth2()` / XOAUTH2 认证，不改变现有 LOGIN 行为；
- 增加 Microsoft 固定主机、OAuth token 刷新和 refresh token 轮换；
- 增加 IMAP `LIST` 响应解析、文件夹选择与安全引用；
- Microsoft 消息使用 `folder + UIDVALIDITY + UID` 作为远端身份，不能只用 UID；
- 不依赖 Gmail 的 `X-GM-MSGID`、`X-GM-THRID` 或 labels；
- 增加 Microsoft 专属账号、消息、同步和错误模型；
- 完整组合中的 password 默认在浏览器丢弃，密码模式则显式加密保存。

## IMAP 收信设计

### 固定网络边界

首期只允许：

- OAuth：`https://login.microsoftonline.com/{authority}/oauth2/v2.0/token`；
- IMAP：`outlook.office365.com:993`，强制 TLS；
- authority：`common`、`consumers`、`organizations` 或合法 tenant UUID。

不得允许导入数据指定任意 OAuth URL、IMAP 主机或端口，避免 SSRF 和任意 TCP 连接。
运行时域名允许列表不包含 `cha.nerver.cc`；实现中不得增加对 Nerver API 的 HTTP 请求或
服务端代理调用。

### 文件夹列表与选择

对应页面的“列出文件夹”和 folder 参数，首期实现：

1. 登录后执行受控 `LIST "" "*"`；
2. 解析 path、name、flags 和 special-use；
3. 前端只能选择服务器返回的文件夹标识，不允许把用户输入直接拼接为 IMAP 命令；
4. 默认选择 `INBOX`；
5. 正确引用带空格、特殊字符和国际化名称的文件夹；
6. 每次 `SELECT` 后记录该文件夹的 `UIDVALIDITY`；
7. `UIDVALIDITY` 改变时废弃该文件夹旧 UID 索引并进行有限重建。

首期可以浏览任意已列出的文件夹，但后台定时同步默认只同步 Inbox。是否让用户为多个文件夹
分别开启后台同步，作为后续独立范围，避免首版成倍增加连接和存储量。

### 邮件列表

对应页面的 1～200 数量参数：

1. 服务端把 limit 限制在 `1..200`，默认 50；
2. `SELECT` 目标文件夹；
3. 使用 `UID SEARCH ALL` 获取 UID；
4. 从最新 UID 中取指定数量，按小批次执行 `UID FETCH`；
5. 列表只取 UID、主题、发件人、收件人、日期、flags、大小和正文预览所需的有限字段；
6. 单次命令、响应字节、总时长和并发连接均设上限；
7. UI 展示真实返回数量，不把 limit 当作服务器一定能返回的数量。

### 正文与附件

读取单封邮件必须同时提供 account、folder、UIDVALIDITY 和 UID。服务端再次校验归属后执行
`UID FETCH ... BODY.PEEK[]`，再通过现有 `postal-mime` 解析：

- text 和 HTML 正文；
- CID 内嵌图片；
- 附件文件名、类型和大小；
- 按需附件下载。

使用 `BODY.PEEK[]`，避免仅因在 OmniMail 打开邮件就把远端标记为已读。继续沿用现有单封、
单附件、HTML 沙箱和文件名安全限制。正文和附件不长期保存在 D1/R2。

### 手动刷新与持续收信

Nerver 页面展示的是一次 HTTP 请求触发一次 IMAP 拉取。OmniMail 需要在此基础上增加持久账号：

- 手动“拉取邮件”立即入队，受冷却和用户/IP 限速保护；
- 现有 Cron 每约 5 分钟扫描到期账号；
- Queue 通过账号同步租约避免并发重复连接；
- OAuth access token 临近过期才刷新；
- 每账号本地最多保留最近 500 封列表元数据；
- 新邮件、flags 和远端删除通过有限 UID 对账更新；
- 网络或 Microsoft 临时错误有限退避，不无限重试。

这属于准实时轮询。首期不使用 IMAP IDLE，因为 Cloudflare Worker 不适合为每个邮箱维持后台常驻
连接；页面和文档应写“定时收信/手动刷新”，不写“秒级实时推送”。

## 凭据存储与并发刷新

新增部署密钥：

```text
MICROSOFT_CREDENTIALS_KEY=<至少 32 个随机 UTF-8 字节>
MICROSOFT_MAIL_ENABLED=true|false
```

OAuth2 账号保存加密的 refresh token，并可加密缓存短期 access token。密码账号仅在用户确认
持久同步后保存加密 password。AAD 至少包含：

```text
user_id + account_id + credential_kind
```

凭据不得出现在响应、日志、审计内容、错误上报、URL、公共缓存或导出结果中。

token 管理器必须处理并发：

- access token 仍有效时复用；
- 需要刷新时先领取账号级 token-refresh lease；
- 同一 refresh token 不并发兑换；
- 成功后原子保存新 access token、替代 refresh token 和到期时间；
- IMAP OAuth 认证失败时只允许强制刷新并重试一次；
- `invalid_grant`、用户撤销、scope 不匹配和租户策略阻止不无限重试。

## 数据模型草案

建议新增 Microsoft IMAP 专属迁移，不复用或改名 Gmail 表。

### `microsoft_imap_accounts`

核心字段：

- `id`, `user_id`, `name`, `provided_email`, `normalized_email`；
- `auth_mode`：`oauth2 | password`；
- `client_id`, `authority`；
- `refresh_token_cipher`, `access_token_cipher`, `access_token_expires_at`；
- `password_cipher`，只允许 password 模式存在；
- `status`：`pending_validation | active | syncing | credential_error | permission_error | error`；
- `last_synced_at`, `next_sync_at`, `last_error_code`, `last_error_at`；
- `sync_lease_id`, `sync_lease_until`, `token_lease_id`, `token_lease_until`；
- `last_manual_sync_at`, `created_at`, `updated_at`。

同一用户的规范邮箱唯一。删除账号时级联删除密文、文件夹缓存和消息元数据。

### `microsoft_imap_folders`

- `account_id`, `path`, `display_name`, `flags`, `special_use`；
- `uid_validity`, `last_uid`, `last_listed_at`；
- `(account_id, path)` 唯一。

### `microsoft_imap_messages`

- `id`, `account_id`, `folder_path`, `uid_validity`, `uid`；
- `internet_message_id`、发件人、收件人、抄送、主题和 preview；
- `received_at`, `sent_at`, `size_bytes`, `flags`, `has_attachments`；
- `created_at`, `updated_at`。

`(account_id, folder_path, uid_validity, uid)` 唯一。UID 不能脱离 folder 和 UIDVALIDITY 单独使用。

### 限速表

复用 Gmail 用户/IP 哈希窗口限速思路，限制批量导入、真实验证、凭据替换、文件夹刷新和手动同步。
迁移 SQL 与 `schema.ts` 的 legacy bootstrap 必须保持一致。

## API 草案

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/microsoft/accounts` | 列出当前用户账号和同步状态 |
| `POST` | `/api/microsoft/accounts/import` | 提交已结构化的单个或批量账号 |
| `PUT` | `/api/microsoft/accounts/{id}/credential` | 显式替换同一认证模式的凭据 |
| `DELETE` | `/api/microsoft/accounts/{id}` | 删除密文和本地索引，不删除远端邮件 |
| `POST` | `/api/microsoft/accounts/{id}/verify` | 重新验证凭据和协议权限 |
| `POST` | `/api/microsoft/accounts/{id}/sync` | 限速后触发 Inbox 同步 |
| `GET` | `/api/microsoft/accounts/{id}/folders` | 从 IMAP 列出文件夹 |
| `GET` | `/api/microsoft/messages` | 按账号/文件夹分页读取本地元数据 |
| `GET` | `/api/microsoft/accounts/{id}/messages/{messageId}` | 按需读取远端 MIME 正文 |
| `GET` | `/api/microsoft/accounts/{id}/messages/{messageId}/attachments/{partId}` | 按需下载附件 |

所有响应使用 `Cache-Control: private, no-store`。每个查询都必须同时校验 account ID、message ID
和当前 user ID。浏览器不得持有保存后的 refresh token、access token 或 password。

## 前端范围

首期新增独立 Microsoft Workspace，保持与 Gmail 相似的工作区结构，不在此任务中重做统一收件箱。

账号导入至少包含：

- “逐行导入”和“分字段输入”两个切换方式；
- 逐行导入明确展示三种格式示例；
- 分字段输入包含 email、可选 password、refresh token 和 client ID；
- 逐行预检、模式识别、重复提示和逐行错误；
- 密码兼容模式的风险说明与单独确认；
- OAuth2 组合默认丢弃 password 的说明；
- `pending_validation`、权限不足、租户禁用 IMAP、凭据撤销和同步错误状态；
- 验证、手动同步、替换凭据、修改备注和断开账号；
- 不显示、复制或导出已保存的敏感凭据。

工作区至少包含：

- 全部账号/单账号筛选；
- 文件夹列表和选择，默认 Inbox；
- 1～200 封拉取数量，默认 50；
- 列表、手动刷新和本地元数据搜索；
- 正文、HTML、CID 图片和附件；
- “约 5 分钟定时收信，不是秒级推送”的准确说明。

当前另有 agent 在修改页面。Microsoft 前端实现应在该任务合并后再接入共享导航、`App.tsx`、i18n
和全局样式，避免覆盖或格式化无关改动。

## 建议文件落点

优先新增：

- Microsoft IMAP 独立 migration；
- `email-worker/src/microsoft-types.ts`；
- `email-worker/src/microsoft-credentials.ts`；
- `email-worker/src/microsoft-token.ts`；
- `email-worker/src/microsoft-imap.ts`；
- `email-worker/src/microsoft-store.ts`；
- `email-worker/src/microsoft-sync.ts`；
- `email-worker/src/microsoft-api.ts` 与 routes；
- 对应的 `*.test.ts`；
- `src/lib/microsoft-api-client.ts`；
- `src/components/MicrosoftWorkspace.tsx`；
- `src/components/MicrosoftAccountDialog.tsx`；
- Microsoft 独立样式和 i18n 文件；
- `docs/MICROSOFT_SETUP.md` 与 `docs/api/microsoft.md`。

必须小范围修改的共享文件：

- `email-worker/src/imap.ts`：新增 XOAUTH2 方法，不改变已有 LOGIN；
- `email-worker/src/types.ts`：Env 和 Queue job union；
- `email-worker/src/mail.ts`：消费 Microsoft sync job；
- `email-worker/src/cleanup.ts`：到期同步入队；
- `email-worker/src/api.ts`：注册 routes；
- `email-worker/src/schema.ts`：migration/旧库 bootstrap；
- `README.md`、`.dev.vars.example`：部署说明；
- 前端导航、public config、API 类型和文档目录。

每个共享文件只增加 Microsoft 所需分支，不顺带统一全部邮箱 provider。

## 分阶段实施与验收

### 阶段 0：真实账号协议探针

任务：

- 使用受控测试账号验证 refresh token + client ID 的兑换；
- 验证 XOAUTH2 登录 `outlook.office365.com:993`；
- 验证 password LOGIN 的真实成功/失败表现；
- 验证 `LIST`、`SELECT`、`UID SEARCH`、列表 FETCH 和完整 MIME FETCH；
- 分别记录 Outlook.com 与范围内 Microsoft 365 租户的策略差异；
- 全程不落库、不记录 token 或 password。

验收：OAuth2 测试账号能列出文件夹并读取一封测试邮件；密码模式得到可解释的成功或稳定错误。

### 阶段 1：三种格式解析与凭据安全

测试先行：

- 完整组合、仅密码、仅 OAuth2 三种成功样例；
- 空 password 的八连字符解析；
- 缺失字段、错误 UUID、多余分隔符、空行、BOM 和重复邮箱；
- 导入预览不回显 token/password；
- OAuth2 组合默认不上传 password；
- password 持久化必须有显式确认；
- AES-GCM 上下文隔离与 migration/bootstrap 一致。

验收：三种格式均能被正确识别，用户能在上传前看清认证模式和密码处理行为。

### 阶段 2：OAuth2 刷新与 IMAP 认证

测试先行：

- access token 缓存和 token-refresh lease；
- 新 refresh token 原子替换；
- XOAUTH2 编码和 IMAP continuation/失败响应；
- LOGIN 与 XOAUTH2 方法互不回退；
- `invalid_grant`、scope 不匹配、租户禁用 IMAP、密码失败和错误脱敏；
- 固定 OAuth/IMAP 主机边界。

验收：OAuth2 账号可重复同步且能自动刷新；密码账号只在显式模式下尝试 LOGIN。

### 阶段 3：文件夹、列表、正文和附件

测试先行：

- LIST flags/special-use、带空格和国际化文件夹名称；
- limit 的默认值、1/200 边界和越界拒绝；
- UID 列表分批 FETCH；
- folder + UIDVALIDITY + UID 的唯一性；
- UIDVALIDITY 变化后的有限重建；
- MIME 正文、HTML、CID 图片、附件和大小限制；
- `BODY.PEEK[]` 不主动标记远端已读；
- 跨用户、跨账号和跨文件夹访问返回 404。

验收：达到参照页面的列文件夹、选文件夹、拉取列表、查看正文和附件能力。

### 阶段 4：Cron + Queue 持续收信

测试先行：

- connect、manual、scheduled 三种任务；
- 同账号同步 lease；
- 新邮件、flags、删除和 UIDVALIDITY 变化；
- 网络失败、连接限制和有限退避；
- 本地 500 封裁剪；
- Gmail、iCloud、Linux DO 和自有邮箱任务互不影响。

验收：手动刷新可立即拉取，定时任务能持续收到新邮件，并准确显示最近同步时间和错误。

### 阶段 5：Microsoft Workspace

在现有页面优化任务合并后开始：

- 逐行/分字段导入及逐行预检；
- 账号、文件夹、limit 和邮件三栏交互；
- 同步状态、错误指引、正文和附件；
- 中文/英文文案、移动端和可访问性；
- E2E mock 覆盖三种导入、文件夹、同步、读信和断开。

验收：不覆盖另一个 agent 的页面修改，不影响现有各邮箱工作区。

### 阶段 6：受控真实环境验收

- Outlook.com/Hotmail 个人账号；
- Microsoft 365 工作/学校账号（只有完成测试才对外宣称支持）；
- 三种输入格式；
- Inbox 和至少一个非 Inbox 文件夹；
- HTML、纯文本、内嵌图片和普通附件；
- token 轮换、用户撤销、密码变化和租户禁用 IMAP；
- 网络中断、并发同步、重复导入和功能开关回滚。

## 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| refresh token 与 client ID 不配套 | connect job 真实兑换；返回稳定 `invalid_grant/token_client_mismatch` |
| token 只有 Graph 权限 | 明确 `imap_scope_missing`；要求重新授权，Graph 后续单独扩展 |
| 租户关闭 IMAP | 明确 `imap_disabled_by_tenant`，不无限重试 |
| 普通密码被 Microsoft 拒绝 | 密码模式标为兼容能力，显示 `basic_auth_rejected` |
| 完整组合意外泄露密码 | OAuth2 默认在浏览器丢弃 password，显式确认才保存兼容凭据 |
| refresh token 并发轮换 | 每账号 token-refresh lease + 原子替换 |
| 文件夹名称注入 IMAP 命令 | 只接受 LIST 返回的标识并严格引用，不拼接任意用户命令 |
| UID 被错误当作全局 ID | 始终绑定 folder + UIDVALIDITY + UID |
| UIDVALIDITY 变化 | 废弃该文件夹旧索引并有限重建 |
| 初始邮箱很大 | limit 最高 200、分批 FETCH、本地最多 500 封元数据 |
| Worker 不适合 IMAP IDLE | 使用手动刷新 + 约 5 分钟 Cron/Queue |
| 密钥或令牌泄漏 | AES-GCM、no-store、日志/审计脱敏、永不回显或导出 |
| 页面并行开发冲突 | 后端新增文件先行，共享前端文件最后接入 |

## 明确不做

首期不包含：

- 自动绕过 MFA、条件访问或租户安全策略；
- ROPC、代理池或自动化获取账号令牌；
- OAuth2 失败后静默降级为密码；
- 硬编码第三方项目或 Microsoft 第一方 Client ID；
- 任意 IMAP 主机、端口或 OAuth URL；
- 后台常驻 IMAP IDLE 或“秒级实时”承诺；
- 发信、回复、删除、移动、归档、星标和远端已读写入；
- shared mailbox、application permissions 或组织全邮箱抓取；
- 首期多文件夹后台持续同步；
- 中国区、GCC High、DoD 等 national cloud；
- 统一重构全部邮箱 provider；
- 长期保存 Microsoft 正文和附件。

## Graph 后续扩展条件

只有出现以下明确需求时，再单独规划 Microsoft Graph 通道：

- 用户提供的 refresh token 只有 `Mail.Read`，无法兑换 IMAP scope；
- 目标租户关闭 IMAP，但允许 Microsoft Graph；
- 需要 webhook、Microsoft 原生文件夹/会话能力或 Graph 专有功能。

Graph 与 IMAP token 的 resource/scope 必须显式区分，不能猜测或混用。Graph 扩展也不应改变
本计划三种逐行格式的解析结果；它只增加一种经真实探针确认后的协议通道。

## 开源实现与官方资料

可借鉴产品和协议边界，但不复制不兼容许可证代码，也不照搬代理、自动化授权、明文密码或默认
Client ID：

- [Nerver Outlook 收件箱](https://cha.nerver.cc/inbox)：三种输入形式和收件箱交互参照；
- [Nerver API 文档](https://cha.nerver.cc/api)：folder、limit、列表、正文和附件返回形态；
- [assast/outlookEmail（MIT）](https://github.com/assast/outlookEmail)：批量组合导入、token 刷新和
  Graph/IMAP 通道区分；
- [Microsoft IMAP/POP/SMTP OAuth 与 XOAUTH2](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)；
- [Microsoft refresh token 生命周期与轮换](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)；
- [Microsoft OAuth 2.0 授权码流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)。

前两项仅作为需求和接口行为调研资料。实现、测试和部署均不得依赖其接口或服务可用性。

## 完成定义

以下条件全部满足才算解决用户需求：

1. 完整组合、仅密码、仅 OAuth2 三种格式都有解析测试和导入预览；
2. OAuth2 账号能刷新 token，并通过 IMAP XOAUTH2 真实登录；
3. 密码账号只在显式兼容模式下 LOGIN，失败时给出准确限制而不是假成功；
4. 完整组合优先 OAuth2，且不会静默回退或意外保存 password；
5. 用户可以列出并选择文件夹，指定 1～200 封邮件；
6. 邮件列表、正文、HTML、CID 图片和附件可以安全读取；
7. 消息身份正确绑定 folder + UIDVALIDITY + UID；
8. 手动刷新和 Cron + Queue 定时收信都可工作；
9. refresh token 轮换、凭据加密、跨用户隔离、限速和错误脱敏都有测试；
10. Gmail、iCloud、Linux DO 和 OmniMail 自有收信链路保持通过；
11. README、部署变量、Microsoft setup、API 和限制说明完整；
12. 至少一个受控 Outlook.com 账号完成 Worker 真实验收；若对外宣称 Microsoft 365 支持，还需
    一个受控工作/学校账号通过真实验收。

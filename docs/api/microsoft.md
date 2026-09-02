<!-- 此文件由 npm run docs:api 自动生成，请修改 src/features/api-guide/model/apiCatalog*.ts 后重新生成。 -->

# Microsoft 邮箱

**Microsoft Mail**

OAuth2 认证、受控 IMAP 同步、正文、附件与精确已读写入。

> OAuth2 authentication, controlled IMAP synchronization, bodies, attachments, and exact Seen writes.

本分类共 **13** 个端点。返回 [完整 API 索引](README.md) 或 [API 架构与安全说明](../API.md)。

<!-- endpoint:GET /api/microsoft/accounts catalog:72ad0c21cd5c -->
## `GET /api/microsoft/accounts`

**列出 Microsoft 账号 / List Microsoft accounts**

返回当前用户的脱敏账号与同步状态，不返回令牌、密码或密文。

> Return sanitized account and synchronization state without tokens, passwords, or ciphertext.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { enabled, accounts } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/microsoft/accounts" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/microsoft/accounts/import catalog:28996798cf8d -->
## `POST /api/microsoft/accounts/import`

**导入 Microsoft 账号 / Import Microsoft accounts**

逐项验证 1–25 个结构化 OAuth2 账号；可确认加密保存四字段组合密码，但不用于认证。

> Validate 1–25 structured OAuth2 accounts; confirmed four-field combination passwords may be stored encrypted but are never used for authentication.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · accounts[1..25] · { name?, email, authMode=oauth2, refreshToken, clientId, authority?, password?, persistPasswordConfirmed? } |
| 成功响应 | 201/207 · { results: [{ index, status=accepted\|duplicate\|error, code?, error?, account?, attempts?: [{ transport=graph\|imap, category, code, status, message }] }] } |

> 注意：服务端只接受结构化字段；不要把整段逐行文本直接提交到该端点。
>
> Note: The server accepts structured fields only; do not submit the raw multiline import text.

> 注意：password 仅作为可选组合密码留存；提交时 persistPasswordConfirmed 必须为 true，且该密码永不参与认证。每项先试 Graph 再试 IMAP；两条通道都被拒绝时返回 code=transport_unavailable 并附 attempts[] 逐通道说明原因。
>
> Note: password is optional retained combination data only; persistPasswordConfirmed must be true when it is sent, and the password is never used for authentication. Each item tries Graph first, then IMAP; when both channels refuse, the item returns code=transport_unavailable with an attempts[] array explaining each channel.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/microsoft/accounts/import" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "accounts": [
    {
      "name": "Outlook",
      "email": "owner@outlook.com",
      "authMode": "oauth2",
      "refreshToken": "refresh-token",
      "clientId": "00000000-0000-4000-8000-000000000000",
      "authority": "common"
    }
  ]
}'
```

<!-- endpoint:PATCH /api/microsoft/accounts/:id catalog:848de51105b0 -->
## `PATCH /api/microsoft/accounts/{id}`

**重命名 Microsoft 账号 / Rename a Microsoft account**

修改当前用户账号的本地显示名称。

> Change the local display name of an account owned by the current user.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · name |
| 成功响应 | 200 · { account } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "name": "Work Outlook"
}'
```

<!-- endpoint:PUT /api/microsoft/accounts/:id/credential catalog:7d512e5f2694 -->
## `PUT /api/microsoft/accounts/{id}/credential`

**替换 Microsoft 凭据 / Replace a Microsoft credential**

验证成功后才替换 OAuth2 凭据；不允许切换为密码认证。

> Replace OAuth2 credentials only after validation; password authentication cannot be enabled.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · authMode=oauth2, refreshToken, clientId, authority? |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request PUT \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id/credential" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "authMode": "oauth2",
  "refreshToken": "replacement-refresh-token",
  "clientId": "00000000-0000-4000-8000-000000000000",
  "authority": "common"
}'
```

<!-- endpoint:DELETE /api/microsoft/accounts/:id catalog:9a407ac3f364 -->
## `DELETE /api/microsoft/accounts/{id}`

**断开 Microsoft 账号 / Disconnect a Microsoft account**

级联删除本地密文、文件夹和元数据索引，不删除远端邮件。

> Cascade-delete local ciphertext, folders, and metadata without deleting remote mail.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 200 · { ok, remoteRevocationRequired } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/microsoft/accounts/:id/verify catalog:c51fd6792ccc -->
## `POST /api/microsoft/accounts/{id}/verify`

**验证 Microsoft 连接 / Verify a Microsoft connection**

用已保存凭据经 Graph/IMAP 级联验证邮箱可达并刷新文件夹缓存；成功通道会记录到账号。

> Validate mailbox access with saved credentials through the Graph/IMAP cascade and refresh the folder cache; the winning channel is recorded on the account.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 200 · { ok, validatedAt } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id/verify" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/microsoft/accounts/:id/sync catalog:9a17df7dc67f -->
## `POST /api/microsoft/accounts/{id}/sync`

**请求 Microsoft 同步 / Request Microsoft synchronization**

在冷却和账号租约保护下，将 INBOX 只读同步加入 Queue。

> Queue read-only INBOX synchronization under cooldown and account lease protection.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 202 · { queued: true } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id/sync" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/microsoft/accounts/:id/folders catalog:174bcfe32e06 -->
## `GET /api/microsoft/accounts/{id}/folders`

**列出 Microsoft 文件夹 / List Microsoft folders**

读取缓存文件夹；refresh=1 时先经当前通道（Graph /me/mailFolders 或 IMAP LIST）安全刷新。

> Read cached folders, optionally refreshing safely through the active channel (Graph /me/mailFolders or IMAP LIST) when refresh=1.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; Query · refresh=0\|1? |
| 成功响应 | 200 · { folders } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/microsoft/accounts/resource_id/folders?refresh=1" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/microsoft/messages catalog:ddd0359935f2 -->
## `GET /api/microsoft/messages`

**列出 Microsoft 邮件 / List Microsoft messages**

按账号与服务器返回的文件夹读取本地元数据，支持搜索、1–200 条和游标分页。

> Read local metadata by account and server-returned folder with search, 1–200 item limits, and cursor pagination.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Query · accountId?, folder?, q?, limit=1..200?, cursor?, refresh=0\|1? |
| 成功响应 | 200 · { messages, page, folderPath } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/microsoft/messages?accountId=microsoft_account_id&folder=INBOX&limit=50" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/microsoft/accounts/:accountId/messages/:messageId catalog:901cd6ba1948 -->
## `GET /api/microsoft/accounts/{accountId}/messages/{messageId}`

**读取 Microsoft 正文 / Read a Microsoft message**

再次校验用户、账号、文件夹与通道内定位（IMAP 行含 UIDVALIDITY）后，按需读取完整 MIME（Graph /$value 或 IMAP BODY.PEEK[]），并对未读邮件先远端标已读（Graph PATCH isRead / IMAP \Seen）再更新本地。

> Revalidate user, account, folder, and the per-channel locator (UIDVALIDITY for IMAP rows), fetch full MIME on demand (Graph /$value or IMAP BODY.PEEK[]), and for unread messages mark read remotely first (Graph PATCH isRead / IMAP Seen) before updating the local index.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · accountId, messageId |
| 成功响应 | 200 · { message } |

> 注意：已读写入失败不会阻断正文响应；Graph 403 会把账号标为 permission_error 且不换通道重放。索引来自另一通道时返回 409 message_locator_stale，刷新列表后重试。移动、删除、归档、星标和其他写入均未开放。
>
> Note: A read-state write failure does not block the body response; a Graph 403 marks the account permission_error and is never replayed over the other channel. A row indexed by the other channel returns 409 message_locator_stale — refresh the list and retry. Move, delete, archive, star, and other writes are not available.

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/microsoft/accounts/microsoft_account_id/messages/message_id" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/microsoft/accounts/:accountId/messages/:messageId/attachments/:partId catalog:179628f0435d -->
## `GET /api/microsoft/accounts/{accountId}/messages/{messageId}/attachments/{partId}`

**下载 Microsoft 附件 / Download a Microsoft attachment**

校验归属后按需读取并返回不超过 5 MiB 的附件。

> Verify ownership, then fetch and return an attachment up to 5 MiB on demand.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · accountId, messageId, partId |
| 成功响应 | 200 · attachment bytes |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/microsoft/accounts/microsoft_account_id/messages/message_id/attachments/0" \
  --header "Authorization: Bearer om_at_..." \
  --output "microsoft-attachment.bin"
```

<!-- endpoint:POST /api/microsoft/graph/notifications catalog:7eb877212d92 -->
## `POST /api/microsoft/graph/notifications`

**接收 Microsoft Graph 变更通知 / Receive Microsoft Graph change notifications**

Microsoft Graph 自己调用，不带请求头签名；带 validationToken 时原样回显握手，否则按请求体内 clientState 的 SHA-256 摘要校验通知后入队文件夹刷新，无论结果如何都回 202。

> Called by Microsoft Graph itself with no header-based signature; echoes the validation handshake verbatim when validationToken is present, otherwise verifies the SHA-256 digest of the clientState carried in the body and queues a folder refresh, always answering 202 regardless of outcome.

| 项目 | 内容 |
| --- | --- |
| 认证 | 公开，无需登录 |
| 请求 | Query · validationToken? (handshake); or JSON · { value: [{ subscriptionId, clientState, changeType, resource }] } |
| 成功响应 | 200 text/plain (握手) 或 202 (通知，恒定) |

> 注意：没有 Svix 之类的请求头签名；真伪校验完全在请求体内完成，clientState 摘要不匹配、subscriptionId 未知或请求畸形都回 202 且不入队，响应从不区分这些情况。按来源 IP 限速 600 次/10 分钟；超限仍回 202 但不再读取请求体。
>
> Note: There is no Svix-style header signature; authenticity is verified entirely from the request body — a clientState digest mismatch, an unknown subscriptionId, or a malformed request all answer 202 without queuing anything, and the response never distinguishes between them. Requests are rate-limited to 600 per 10 minutes per source IP; over the limit still answers 202 but stops reading the body.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/microsoft/graph/notifications" \
  --header "Content-Type: application/json" \
  --data '{
  "value": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000000",
      "clientState": "opaque-client-state",
      "changeType": "created",
      "resource": "Users/{id}/Messages/{id}"
    }
  ]
}'
```

<!-- endpoint:POST /api/microsoft/graph/lifecycle catalog:100d02b4e901 -->
## `POST /api/microsoft/graph/lifecycle`

**接收 Microsoft Graph 订阅生命周期事件 / Receive Microsoft Graph subscription lifecycle events**

Microsoft Graph 自己调用，不带请求头签名；处理同一份握手契约，并把 subscriptionRemoved/reauthorizationRequired 标记为待重建、missed 当作一次通知触发防御性刷新。

> Called by Microsoft Graph itself with no header-based signature; shares the same handshake contract, and marks subscriptionRemoved/reauthorizationRequired for rebuild while treating missed as a notification that triggers a defensive refresh.

| 项目 | 内容 |
| --- | --- |
| 认证 | 公开，无需登录 |
| 请求 | Query · validationToken? (handshake); or JSON · { value: [{ subscriptionId, clientState, lifecycleEvent }] } |
| 成功响应 | 200 text/plain (握手) 或 202 (事件，恒定) |

> 注意：下一轮 Cron 对账负责实际重建订阅；该端点本身只落一次状态标记，不直接调用 Microsoft Graph。
>
> Note: The next cron reconciliation pass is responsible for the actual rebuild; this endpoint itself only records a status marker and never calls Microsoft Graph directly.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/microsoft/graph/lifecycle" \
  --header "Content-Type: application/json" \
  --data '{
  "value": [
    {
      "subscriptionId": "00000000-0000-4000-8000-000000000000",
      "clientState": "opaque-client-state",
      "lifecycleEvent": "subscriptionRemoved"
    }
  ]
}'
```

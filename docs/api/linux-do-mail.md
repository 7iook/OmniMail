<!-- 此文件由 npm run docs:api 自动生成，请修改 src/lib/apiCatalog*.ts 后重新生成。 -->

# Linux DO 邮箱

**Linux DO Mail**

加密连接 Linux DO Mail，并按需只读访问 INBOX。

> Connect Linux DO Mail with encrypted credentials and read INBOX on demand.

本分类共 **7** 个端点。返回 [完整 API 索引](README.md) 或 [API 架构与安全说明](../API.md)。

<!-- endpoint:GET /api/linux-do-mail/account catalog:f9b5fa6d7c1e -->
## `GET /api/linux-do-mail/account`

**读取 Linux DO Mail 连接 / Read the Linux DO Mail connection**

返回功能状态和当前用户的脱敏账号信息，不返回密码或认证令牌。

> Return feature status and sanitized account metadata without returning the password or authentication token.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { enabled, account } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/linux-do-mail/account" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/linux-do-mail/account catalog:f37b0906ff3c -->
## `POST /api/linux-do-mail/account`

**连接 Linux DO Mail / Connect Linux DO Mail**

使用完整邮箱用户名和密码或认证令牌验证 IMAP，再加密保存凭据。

> Validate IMAP with the full mailbox username and a password or authentication token, then encrypt the credential.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · username, password |
| 成功响应 | 201 · { account } |

> 注意：官方建议使用可撤销的专用认证令牌，不要提交邮箱主密码。
>
> Note: Linux DO recommends a revocable dedicated authentication token instead of the mailbox master password.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/linux-do-mail/account" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "username": "member@linux.do",
  "password": "authentication-token"
}'
```

<!-- endpoint:DELETE /api/linux-do-mail/account catalog:e5593b9dc201 -->
## `DELETE /api/linux-do-mail/account`

**断开 Linux DO Mail / Disconnect Linux DO Mail**

删除当前用户的账号记录和凭据密文，不修改服务器端邮箱。

> Delete the current user’s account record and encrypted credential without changing the server-side mailbox.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/linux-do-mail/account" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/linux-do-mail/account/verify catalog:e072b6ff66c1 -->
## `POST /api/linux-do-mail/account/verify`

**验证 Linux DO Mail 凭据 / Verify Linux DO Mail credentials**

重新登录 IMAP 并执行只读 EXAMINE INBOX。

> Sign in to IMAP again and run the read-only EXAMINE INBOX command.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { ok: true, validatedAt } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/linux-do-mail/account/verify" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:PUT /api/linux-do-mail/account/credential catalog:2e731940d2c8 -->
## `PUT /api/linux-do-mail/account/credential`

**更新 Linux DO Mail 凭据 / Update the Linux DO Mail credential**

先验证新密码或认证令牌，再替换已保存的密文；验证失败时保留原凭据。

> Validate the new password or authentication token before replacing the saved ciphertext; keep the existing credential when validation fails.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · password |
| 成功响应 | 200 · { account } |

> 注意：响应不会包含新旧凭据。
>
> Note: The response never contains the old or new credential.

### cURL 示例

```bash
curl --request PUT \
  --url "https://mail.example.com/api/linux-do-mail/account/credential" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "password": "new-authentication-token"
}'
```

<!-- endpoint:GET /api/linux-do-mail/inbox catalog:217cd01fb08d -->
## `GET /api/linux-do-mail/inbox`

**读取 Linux DO Mail 最近来信 / List recent Linux DO Mail messages**

按用户操作通过 IMAP 读取 INBOX 中最近 20 封邮件摘要，不做后台同步。

> Read summaries for the 20 most recent INBOX messages over IMAP on demand without background sync.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { messages } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/linux-do-mail/inbox" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/linux-do-mail/inbox/:uid catalog:54cd9f206b97 -->
## `GET /api/linux-do-mail/inbox/{uid}`

**读取 Linux DO Mail 正文 / Read a Linux DO Mail message**

通过数字 IMAP UID 只读获取受大小限制的邮件正文。

> Read a size-limited message by numeric IMAP UID without changing mailbox state.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · uid |
| 成功响应 | 200 · { message } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/linux-do-mail/inbox/123" \
  --header "Authorization: Bearer om_at_..."
```

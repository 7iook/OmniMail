# ADR 0001：Microsoft 邮箱双通道传输与跨通道消息身份

- 状态：**Accepted**
- 日期：2026-09-01（提案）/ 2026-09-02（实现合入 `feat/microsoft-graph-channel`，Accepted）
- 范围：`email-worker/src/features/microsoft/`、`migrations/0036_microsoft_transport_channel.sql`
- 相关：[当前实现说明](../MICROSOFT_MAIL_INTEGRATION_PLAN.md) §4–§6 描述落地后的代码；本文只记录为什么。

## 1. 背景

Microsoft 邮箱首版仅有 IMAP 单通道：refresh token → IMAP XOAUTH2 → `outlook.office365.com:993`。
2026-09-01 的 RCA 发现，用户批量导入的 20 个真实 Outlook 凭据在 IMAP 侧被 Microsoft **静默拒绝**
（token 兑换成功、XOAUTH2 登录被拒），导入 0/20。受控实测同一批 refresh token：只改 scope 一个
变量，Microsoft Graph token 兑换 20/20 成功、`Mail.ReadWrite` 20/20 授予、真实
`GET /me/mailFolders/inbox/messages` 20/20 HTTP 200。结论：这批号（以及所有租户关闭 IMAP 的
Microsoft 365 账号）只能经 Graph 访问，而存量号仍可能只在 IMAP 上稳定。

接入 Graph 立刻碰到数据模型问题：既有消息表用 `(account_id, folder_path, uid_validity, imap_uid)`
作唯一键，`uid_validity`/`imap_uid` 均为 `INTEGER NOT NULL CHECK (> 0)`；实测 Graph 消息 ID 长约
140 字符、非纯数字，物理上装不进这两列，Graph 也没有 UIDVALIDITY 概念。

## 2. 决策

**D1 · 两条通道都保留，自动级联并带粘性。**

- 通道决议只有一处（`microsoft-session.ts` `cascade()`）；导入、替换凭据、验证、同步、刷新、
  读正文全部经它取得 `MicrosoftMailTransport`。
- `preferred_transport ∈ {unknown, graph, imap}` 是账号级路由状态的唯一真源；`unknown` 先试
  Graph。成功通道用**条件更新**写回（`WHERE preferred_transport = <旧值>`），并发同步不互相覆盖。
- 只有 `auth`/`permission` 类失败允许换通道并改写粘性；`throttled`/`transient`/`contract`/
  `data` 一律不换、不改写（换通道等于绕开限流制造额外负载，瞬时故障会让粘性抖动）。写操作遇
  `permission` 也不换通道，记 `permission_error` 让用户重新授权——跨通道重放写操作可能标错邮件。

**D2 · 消息身份分两层。**

| 层 | 键 | 用途 |
| --- | --- | --- |
| 跨通道身份 | `internet_message_id`（RFC5322 Message-ID，非空时） | 去重：同一封信经两条通道各抓一次只留一行 |
| 通道内定位 | `(source_transport, remote_id)` | 取正文、标已读、删除对账；不可跨通道比较 |

- `remote_id TEXT`；`uid_validity` 可空，表级 CHECK 强制「IMAP 行必有 / Graph 行必无」。
- 两条唯一约束并存：`UNIQUE (account_id, folder_path, source_transport, remote_id)` +
  部分唯一索引 `(account_id, internet_message_id) WHERE internet_message_id != ''`。
- `source_transport`（消息级事实）与 `preferred_transport`（账号级路由）与 `auth_mode`
  （凭据类型）三个字段严格分离，不互相兼任。
- 删除对账只在同一 `source_transport` 内比较远端集合与本地行。

## 3. 考虑过的替代方案

| 方案 | 为什么没选 |
| --- | --- |
| **① 沿用纯 IMAP** | 那 20 个号在 OmniMail 永远不可用；Microsoft 持续收紧 IMAP，存量号也可能陆续失效。 |
| **② 新号纯 Graph、存量 IMAP 保留，不做级联** | 成本最低（约省 55–65%），同平台先例 `cf-outlook-email` 即此形态，也是实施方原本的推荐。但同一号原通道失效时需手动重导，且仍绕不开消息身份泛化。用户明确选 ①③ 之间的 ③。 |
| **③ 双通道级联 + 粘性（选定）** | 覆盖面最全：单号任一通道可用即可用。代价是级联 SSOT、回退矩阵、并发守卫和跨通道对账，全部需要额外不变量守护。 |
| **④ 给 Graph 建独立表 `microsoft_graph_messages`** | 破坏共用的列表 API 与游标，两套查询路径，造出第二个 SSOT。 |
| **给 Graph 编造假整数 UID 塞进旧列** | 制造第二身份源；假 UID 与 UIDVALIDITY 语义都是谎言，任何依赖 UID 单调性的逻辑会静默出错。 |
| **在共用函数 `refreshMicrosoftFolderWithClient` 内按通道分支** | 该函数同时服务定时同步与手动刷新，分支会污染两处；改为传输接口 + 无分支编排器（`microsoft-sync-folder.ts`）。 |
| **唯一键含 `channel`（原稿）** | 与「同一封信只一行」自相矛盾：两通道各成一行。评审 A1 指出后改为上面的两层身份。 |

## 4. 后果

正面：

- 租户关闭 IMAP 的账号可用；单号任一通道存活即可收信；通道切换对用户透明，界面不显示通道。
- 通道相关的判断集中在三个文件（`microsoft-session.ts` 决议、`microsoft-transport-errors.ts`
  分类与回退矩阵、`microsoft-graph.ts` `request()` 限流/分页），其余代码不分支。
- 429 严格遵守 `Retry-After`（在 `request()` 内等待，预算耗尽才上报调度），分页只跟
  `@odata.nextLink`，`nextLink` 必须同源，token 不会外泄。

代价与收缩的承诺：

- **I-2b**：`internet_message_id` 为空的邮件**不保证**跨通道去重——这类行退回通道内唯一，切换
  通道后可能出现两行，也无法被另一通道认领。这是显式收缩，不是假装解决。
- 通道切换后、下一次刷新前，旧通道的行被读取返回 409 `message_locator_stale`，刷新后按
  Message-ID 重新认领。
- 写操作缺权限（Graph 403 / 缺 `Mail.ReadWrite`）→ 账号进入 `permission_error`，**定时与手动
  同步随之暂停**直到替换凭据。这沿用了 IMAP 时代「权限错误停同步」的规则，对「只读权限有、写
  权限无」的账号偏严；实测 20 个号写权限全有，本轮接受。
- 非 INBOX 文件夹两通道命名不同（IMAP `Sent Items` vs Graph 本地化 `displayName`），切换通道
  后刷新此类文件夹可能 404 `graph_invalid_folder`；需要 folder-id 映射列才能解决，本轮不做。
- Graph 行 `size_bytes` 为 0（v1.0 `message` 无 `size`，未启用 `$expand`）；`last_uid` 列保留但
  恒 0。
- 迁移 0036 重建消息表，前提是表为空（生产确认无数据）；迁移在表非空时主动失败中止。若日后在
  有数据的环境执行，必须改走「建新表 + 回填 + 行数守恒对账」。
- 两条通道的 access token 不可互换（scope 不同），故账号表多两列（`graph_access_token_cipher`、
  `graph_access_token_expires_at`）和一个独立 AAD 上下文。

## 5. 验证

- 单元/集成测试覆盖：`unknown` 先 Graph、粘性、只有 auth/permission 换通道、条件写回、429 等待
  且不换通道、nextLink 跨页、Message-ID 去重、空 Message-ID 退回、同通道删除对账、先远端后本地
  已读、迁移 0036 真实执行。
- 真实凭据验收：`scripts/microsoft-graph-e2e.ps1`（导入 20 号全 `accepted`；列信 200 且
  `messages` 为数组——18/20 收件箱为空，空数组即成功；#13/#15 读正文非空且 `isRead: true`）。
  单测全绿不构成达标。

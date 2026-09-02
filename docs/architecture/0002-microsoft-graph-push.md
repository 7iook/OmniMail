# ADR 0002：Microsoft Graph 变更通知推送

- 状态：**Accepted**
- 日期：2026-09-02（提案）/ 2026-09-03（实现合入 `feat/microsoft-graph-push`，Accepted）
- 范围：`email-worker/src/features/microsoft/microsoft-graph-notifications.ts`、
  `microsoft-graph-subscriptions.ts`、`microsoft-graph-subscription-store.ts`、
  `microsoft-graph-subscription-lifecycle.ts`、`microsoft-graph-reconcile.ts`、
  `migrations/0037_microsoft_graph_subscriptions.sql`
- 相关：[当前实现说明](../MICROSOFT_MAIL_INTEGRATION_PLAN.md) §12 描述落地后的代码；
  [ADR 0001](0001-microsoft-transport-identity.md) 记录本决策依赖的双通道传输与粘性；
  本文只记录为什么。

## 1. 背景

用户把 OmniMail 的 Microsoft 邮箱当接码/OTP 收件工具用：验证码通常几十秒内就要输入，而
既有 5 分钟 Cron 同步等不起。实测还发现验证码经常落进 Outlook 的 **Junk Email**，当前同步
范围（INBOX only）完全看不到它——两个问题叠加：不推送，用户就得开着页面手动等还未必等到；
不覆盖 Junk，验证码等于从未到达。

Graph 提供官方的 change-notification（webhook）机制：`POST /subscriptions` 订阅一个文件夹的
`created` 事件，Microsoft 有新信时主动回调；Outlook message 订阅上限 7 天，需要续期。生态里的
同类接码工具和参照实现（`outlook-mail-fetcher`、`otp-gateway`、`cf-outlook-email`）无一例外走
客户端按需 3 秒轮询 Graph 本身，没有任何一个用后台推送——这条路径没有现成先例可抄，设计只能
从官方文档和真实探针推出。

## 2. 决策

**Webhook 推送 + Cron 对账兜底，Junk Email 纳入 Graph 通道的同步与推送范围。**

- 只对 `preferred_transport = graph` 的账号创建订阅（`inbox`、`junkemail` 各一个）；IMAP
  账号没有 IDLE，也没有推送，继续用今天的 Cron 轮询。
- 通知到达后不直接处理，只做 `clientState` 摘要校验 + 合并入队（C-3 状态机）；真正的刷新走
  既有队列消费者路径（复用 `refreshMicrosoftFolderWithTransport` 的级联编排），不建第二套
  同步逻辑。
- 既有 5 分钟 Cron 保留作兜底：新增 `reconcileDueMicrosoftGraphSubscriptions` 每轮续期到期
  订阅、补建缺失订阅、用 `GET /subscriptions` 做双向对账清理孤儿。订阅是否存活完全不影响
  账号本身能不能读信——这是两条独立的失败轴（I-13）。
- Microsoft 页面（P2-W4）固定 5 秒本地轮询 D1，**不复用**全局可调的 `mailRefreshInterval`：
  该设置管理员可调到 0/10/30/60/120 秒并可能触发自适应退避，任何一档都无法承诺「Outlook 收
  到即入库后 ≤5 秒在页面上看到」这个用户可见指标；固定值是唯一能兑现它的做法。全局刷新设为
  0（关闭）时页面显式停止轮询并标注，这是唯一与全局设置同步的开关。

## 3. 考虑过的替代方案

| 方案 | 为什么没选 |
| --- | --- |
| **客户端 3 秒轮询 Graph（同类工具的通用做法）** | 每个打开页面的用户每 3 秒直接打一次 Graph，配额消耗随并发用户数线性增长；OmniMail 是多用户多账号部署，推送模型下对 Graph 的调用量 = 通知数 + 每轮续期检查，量级远低于轮询。也解决不了「不开页面就收不到」。 |
| **把 Cron 缩短到 1 分钟** | 仍达不到秒级预期，且对所有账号（包括不需要接码的）无差别加压 Graph 配额，性价比更差。 |
| **Rich notifications（加密通知，内嵌资源数据）** | 需要证书，且通知寿命只有 1 天（续期成本高于 7 天的普通订阅）；换来的好处（省一次收到后的回源拉取）对这个场景不值得，收到通知后自己拉一次已经足够简单。 |
| **Azure Event Hubs / Event Grid 投递** | 引入独立的 Azure 资源和凭据，超出「只用 Graph 官方 HTTP + Cloudflare Workers」的既有边界，运维面显著增大。 |
| **在 Workers 里跑 IMAP IDLE** | Workers 是短生命周期的请求模型，没有长连接能力；即使能连，也只覆盖 IMAP 通道，Graph 账号仍需要另一套机制。 |
| **Microsoft 页面复用全局 `mailRefreshInterval`** | 该设置可调到 0/10/30/60/120 秒并可能触发自适应退避；任何一档都无法保证「≤5 秒」这个指标，选它等于放弃它。 |

## 4. 后果

正面：

- 账号读信健康度与订阅健康度完全独立：订阅被拒绝（403、租户策略禁止 webhook）只影响这条
  推送加速通道，`preferred_transport` 不受影响，账号继续用今天的 Cron 兜底收信。
- 通知风暴（同一 `(account, folder)` 短时间收到多条通知，或一次到达多封信）被 C-3 状态机
  收敛为最多一次在飞刷新 + 一次尾随刷新，不会放大成 N 次 Graph 调用。
- Junk Email 的固定路径合成复用了 INBOX 已经验证过的手法（well-known name 寻址 + 固定字面
  路径），没有引入新的 schema 或本地化映射列。

代价与收缩的承诺：

- **公网攻击面（I-8）**：通知端点必须公开、无鉴权即可 `POST`。缓解措施是 C-1（`clientState`
  只存 SHA-256 摘要，从不落明文，timing-safe 比较）+ 响应统一 `202`（命中、未命中、未知 id、
  畸形请求从不区分，探测者学不到任何信号）+ 按 IP 的 D1 CAS 计数（600 次/10 分钟）。即便这
  一层被绕过，最坏后果也只是触发一次只读的文件夹刷新，不产生任何写操作。
- **两侧资源的一致性成本（C-2）**：订阅是双边资源，本地表只是「我们认为的状态」；创建结果
  不确定（超时但可能已经创建）时本地不写行，靠下一轮 `GET /subscriptions` 对账收敛，短暂的
  孤儿窗口是显式接受的代价，不是缺陷。
- **失败必须是独立分类轴（I-13）**：订阅 API 的 403 绝不能并入既有的 auth/permission 换通道
  判定，否则一个只是被租户禁止 webhook、读信完全健康的 Graph 邮箱会被误判换到 IMAP。
- **全局刷新间隔不复用**：Microsoft 页面固定 5 秒轮询是这个功能里唯一没有复用现成通用刷新
  机制（`useAutoRefresh`/`useMailboxRefresh` 的可调间隔）的地方；管理员改动全局间隔不会改变
  这个页面的轮询频率，全局设为 0 是唯一同步的开关。
- 账号被删除后，它在 Microsoft 侧的订阅最坏可能存活到自然过期（≤7 天），期间到达的通知因为
  查不到本地行而被丢弃；这是显式接受的边界，写进文档而不是留作隐性行为。

## 5. 验证

- 单元/集成测试覆盖：握手零 D1 访问、`clientState` 摘要校验、畸形/超限/未知 id 统一 `202`、
  IP 计数、C-3 状态机（含 10 分钟崩溃恢复与风暴合并）、C-4 Graph-pinned 跳过非 Graph 账号、
  C-5 调度退避（`rejected` 24 小时 / 瞬时 5m→15m→1h→6h）、C-2 双向对账，均使用真实 SQLite
  或 fake client/repository，不依赖网络。
- 真实凭据验收：部署握手空壳后，用一个真实账号的 access token 直接对线上端点
  `POST /subscriptions` 两次（`inbox`、`junkemail`）——两次均 `201`（微软对我们端点的握手
  通过），随即 `DELETE` 两个探针订阅成功；据此排除了决策卡的停止条件 S-5（微软拒绝创建
  订阅）与 S-8（`junkemail` well-known 名不可订阅）。到达延迟、风暴合并倍数、订阅续期等
  真跑项需要在已部署的 Worker 上用 `scripts/microsoft-graph-e2e.ps1` 的 `-ArrivalProbe` /
  `-CheckSubscriptions` 验证，单测全绿不构成达标。

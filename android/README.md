# OmniMail Android

OmniMail 的原生 Android 客户端，面向手机和平板。客户端直接连接用户自托管的
OmniMail Worker API，不保存 Cloudflare、Resend 或 SendFlare 密钥。

## 当前阶段

第一阶段实现最小纵向闭环：

- 配置并校验 HTTPS OmniMail 实例地址；
- 使用设备 Access / Refresh Token 登录，兼容 TOTP 与恢复码；
- 手机单栏、平板双栏/三栏自适应邮箱界面；
- 收件箱、星标、已发送和垃圾箱；
- 邮件详情、已读和星标操作；
- 设置页显示当前版本，并检查包含 Android APK 的 GitHub Release。

完整范围与分期见 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)。

## 构建

要求 JDK 17、Android SDK 36。首次克隆后执行：

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug
```

Debug APK 输出到 `app/build/outputs/apk/debug/app-debug.apk`。

## 安全边界

- 生产实例只允许 HTTPS；Android 清文流量被禁用。
- Access Token 只保存在进程内存中。
- Refresh Token 由 Android Keystore 的 AES-GCM 密钥加密后保存。
- HTML 邮件不会直接注入 Compose；首版仅显示纯文本正文。

# OmniMail Float 浏览器扩展

OmniMail Float 是与本仓库一起构建的 Chrome Manifest V3 扩展。它在普通网页中
注入一个隔离的悬浮入口，通过 OmniMail 网站授权获得可撤销的设备令牌，用于生成
邮箱、查看收件箱并接收新邮件通知。扩展不会收集或处理用户密码。

隐私政策见 [`docs/EXTENSION_PRIVACY.md`](../docs/EXTENSION_PRIVACY.md)。

## 构建与安装

```powershell
npm install
npm run build:extension
```

然后打开 `chrome://extensions/`，启用开发者模式，选择“加载已解压的扩展程序”，
加载仓库根目录下的 `dist-extension/`。

扩展只会注入普通 HTTP/HTTPS 页面，无法注入 `chrome://`、Chrome 扩展商店等浏览器
内部页面。

## 配置 API 来源

Chrome Web Store 正式版本的扩展 ID 是 `fpeecjailboemocpmpcbjaghpkpcaihf`。

1. 在 `chrome://extensions/` 复制 OmniMail Float 的 32 位扩展 ID。
2. 在 Worker 的 `APP_ORIGINS` 中加入对应来源：

   ```text
   chrome-extension://你的扩展ID
   ```

3. 如果 `APP_ORIGINS` 已包含其他来源，使用英文逗号分隔。
4. 重新部署 Worker 后，在扩展中填写 OmniMail 站点根地址并点击“前往 OmniMail
   授权”。

通过 Chrome Web Store 安装时扩展 ID 固定；开发者模式下只要保持扩展目录和清单
不变，ID 通常也会保持不变。

## 安全边界

- 登录使用 Chrome Identity、一次性授权码和 PKCE S256；密码与 MFA 只在 OmniMail
  网站中处理。
- 授权码两分钟内有效、只能兑换一次，并且在 D1 中只保存哈希。
- Access Token 和 Refresh Token 仅存放在 `chrome.storage.session`，浏览器重启后需要
  重新登录。
- Content Script 只负责悬浮窗口和当前页面邮箱输入框填充，不能读取令牌。
- Service Worker 只接受预定义的 OmniMail API 操作，不提供任意 URL 请求代理。
- 邮件 HTML 在 sandbox iframe 中显示，脚本、表单、远程图片和危险属性会被移除。
- 为了自动显示悬浮入口，扩展需要访问普通 HTTP/HTTPS 网页；可以在扩展设置里关闭
  悬浮按钮。

开发者模式扩展和 Chrome Web Store 扩展通常具有不同 ID。如果两者都需要访问同一
个 OmniMail 实例，应把两个 `chrome-extension://扩展ID` 来源都加入 `APP_ORIGINS`，
并使用英文逗号分隔。

# 版本发布说明

网站与 Android 使用独立版本和独立发布说明：

```text
docs/releases/web/vX.Y.Z.md
docs/releases/android/android-vX.Y.Z.md
```

发布网站版本时：

1. 复制 [`web/TEMPLATE.md`](./web/TEMPLATE.md) 为 `web/vX.Y.Z.md`。
2. 将 `package.json`、`package-lock.json` 及根包版本更新为 `X.Y.Z`。
3. 创建并推送 `vX.Y.Z` Tag。

发布 Android 版本时：

1. 复制 [`android/TEMPLATE.md`](./android/TEMPLATE.md) 为
   `android/android-vX.Y.Z.md`。
2. 创建并推送 `android-vX.Y.Z` Tag。

两条 Release Action 只读取各自目录中与 Tag 同名的文件。文件缺失或内容为空时，
对应发布会直接失败；验证通过后，该文件会原样用作 GitHub Release 正文。

[`CHANGELOG.md`](../../CHANGELOG.md) 保留现有的聚合版本历史，不再作为 Release Action
的发布日志来源。

# 版本发布说明

GitHub Release 使用一版一文件的发布说明，文件名必须与 Git Tag 完全一致：

```text
docs/releases/vX.Y.Z.md
```

发布新版本时：

1. 复制 [`TEMPLATE.md`](./TEMPLATE.md) 为 `vX.Y.Z.md`。
2. 删除不适用的章节，填写面向使用者的变化、升级要求和已知限制。
3. 将 `package.json`、`package-lock.json` 及根包版本更新为 `X.Y.Z`。
4. 创建并推送 `vX.Y.Z` Tag。

Release Action 会验证 Tag、包版本和对应发布说明文件。文件缺失或内容为空时，发布会
直接失败；验证通过后，该文件会原样用作 GitHub Release 正文。

[`CHANGELOG.md`](../../CHANGELOG.md) 保留现有的聚合版本历史，不再作为 Release Action
的发布日志来源。

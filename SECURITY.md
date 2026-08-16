# 安全策略

## 报告漏洞

如果你发现安全漏洞，请**不要**在公开 Issue 中提交详情。

请通过 [GitHub 私密漏洞报告](https://github.com/Bavoch/hello-gitty/security/advisories/new)提交，或通过 GitHub 个人资料页私信联系维护者 [@Bavoch](https://github.com/Bavoch)。

报告时请尽量包含：

- 漏洞类型（如命令注入、路径穿越、凭证泄露等）
- 复现步骤或概念验证代码
- 影响范围与受影响的版本
- 你建议的修复思路（可选）

## 处理流程

1. 收到报告后会在 7 天内确认收到
2. 评估影响范围并确定修复优先级
3. 修复完成后通过 GitHub Security Advisory 发布公告，并感谢报告者

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 最新 Release | ✅ 支持 |
| 旧版本 | ❌ 不支持，请升级到最新版 |

## 安全边界说明

Hello Gitty 通过调用系统 `git` CLI 工作，AI 请求走你配置的 OpenAI 兼容接口，API Key 仅保存在本机配置文件中，不会上传到任何第三方服务。使用非官方 AI 接口地址时请注意自行评估数据安全。

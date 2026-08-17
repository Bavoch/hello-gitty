# 贡献指南

简体中文 | [English](CONTRIBUTING.en.md)

感谢你愿意为 Hello Gitty 贡献代码！请花几分钟读完这份指南。

## 开发环境

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/) 工具链
- 本仓库依赖系统 `git` CLI

```bash
npm ci
npm run dev    # 开发模式（保存后窗口自动重载）
npm run build  # 当前系统原生安装包：macOS .dmg / Windows NSIS setup.exe
```

## 提 Issue

- 先用搜索确认是否已有重复 Issue。
- Bug 请附上：系统环境、Tauri/应用版本、复现步骤、期望与实际行为、相关日志。
- 功能建议请说明使用场景和期望效果。

## 提 PR

1. Fork 本仓库并新建分支：`git checkout -b feat/your-feature`
2. 提交前执行 `cargo test --manifest-path src-tauri/Cargo.toml` 与 `npm run build:debug`。
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（如 `feat:`、`fix:`、`refactor:`）。
4. 确保 PR 描述清楚改动内容和动机，关联相关 Issue。

## 代码规范

- 前端为原生 HTML/CSS/JS（ES Modules），不要引入打包器。
- Rust 后端沿用现有模块划分（`git.rs` / `ai.rs` / `runner.rs` / `process.rs` / `config.rs` / `lib.rs`）。
- 注释只解释「为什么」，不解释「是什么/怎么做」。

## 发布（维护者）

推送 `v*` tag 触发 Release 工作流，自动构建 macOS/Windows 安装包并生成应用内更新所需的 `latest.json`。构建时用仓库 Secrets 中的更新签名私钥签名：

- `TAURI_SIGNING_PRIVATE_KEY`：`.tauri/updater.key` 的完整内容（密钥不入库，妥善备份；**丢失后已发布版本将无法收到更新**）
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时的密码（本仓库密钥无密码，设为空字符串）

## 协议

提交代码即表示你同意以 [MIT 协议](LICENSE) 授权你的贡献。

# 贡献指南

感谢你愿意为 Hello Gitty 贡献代码！请花几分钟读完这份指南。

## 开发环境

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/) 工具链
- 本仓库依赖系统 `git` CLI

```bash
npm install
npm run dev    # 开发模式（需 python3 提供静态服务）
npm run build  # 打包 .app / .dmg
```

## 提 Issue

- 先用搜索确认是否已有重复 Issue。
- Bug 请附上：系统环境、Tauri/应用版本、复现步骤、期望与实际行为、相关日志。
- 功能建议请说明使用场景和期望效果。

## 提 PR

1. Fork 本仓库并新建分支：`git checkout -b feat/your-feature`
2. 提交前跑一遍 `npm run build:debug` 确保能编译。
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（如 `feat:`、`fix:`、`refactor:`）。
4. 确保 PR 描述清楚改动内容和动机，关联相关 Issue。

## 代码规范

- 前端为原生 HTML/CSS/JS（ES Modules），不要引入打包器。
- Rust 后端沿用现有模块划分（`git.rs` / `ai.rs` / `config.rs` / `lib.rs`）。
- 注释只解释「为什么」，不解释「是什么/怎么做」。

## 协议

提交代码即表示你同意以 [MIT 协议](LICENSE) 授权你的贡献。

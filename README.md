# Hello Gitty 🐱

轻量桌面 Git 管理工具,为单人 AI 开发者定制。类 VS Code Git 面板,但只保留最常用的操作,提交信息与冲突解决完全交给 AI。

## 功能

| 操作 | 说明 |
| --- | --- |
| 全部暂存 / 取消暂存 | 一键 `git add -A` / `git reset` |
| 提交 | 只提交已暂存的内容(不自动暂存)→ **AI 生成提交信息** → 提交(默认直接提交,可改为生成后确认) |
| 推送 / 拉取 | 自动处理无上游分支的情况(`-u origin <branch>`) |
| AI 冲突解决 | 冲突文件逐个交给 AI 合并,解决后自动 `git add` |
| 单文件暂存 | 文件行点击即暂存/取消,悬停可操作 |

## 技术栈

- **Tauri 2** + Rust 后端(系统 git CLI,约 10 MB 安装包)
- 原生 HTML/CSS/JS 前端,无打包器
- AI 走 OpenAI 兼容接口(OpenAI / DeepSeek / 通义 / 本地服务均可),Key 只存本机

## 开发

```bash
npm install
npm run dev      # 开发模式(需 python3 提供静态服务)
npm run build    # 打包 .app / .dmg
```

## 使用

1. 打开应用 → 「选择仓库」选任意 git 文件夹(非仓库可现场初始化)
2. 右上角设置 → 填 API 地址 / Key / 模型 / 提交信息语言
3. 日常只用四个按钮:全部暂存 · 提交 · 推送 · 拉取

## 结构

```
src/                前端(静态,无构建)
src-tauri/src/      后端
  git.rs            git CLI 封装 + porcelain v2 解析
  ai.rs             AI 提交信息 / 冲突解决
  config.rs         设置持久化
  lib.rs            Tauri 命令
```

## 已知边界

- 冲突文件 > 80 KB 时 AI 无法处理,需手动解决(应用会提示)
- 远端需要凭证时,复用系统 git 凭据助手(如 macOS Keychain)
- 尊重仓库 hooks(`--no-verify` 不启用)

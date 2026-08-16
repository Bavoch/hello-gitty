<p align="center">
  <img src="src/favicon.png" alt="Hello Gitty" width="120" />
</p>

# Hello Gitty 🐱

[![Windows CI](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml/badge.svg)](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml)
[![Release](https://img.shields.io/github/v/release/Bavoch/hello-gitty)](https://github.com/Bavoch/hello-gitty/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

轻量桌面 Git 管理工具，为**单人 AI 开发者**定制。

类 VS Code Git 面板，但只保留最常用的操作。提交信息与冲突解决完全交给 AI，开发服务器也能在应用内一键启停——Git、AI、运行三件事，一个 10 MB 的工具闭环。

## 亮点

- **AI 自动生成提交信息** — 基于暂存区 diff + 你近期的提交风格，流式生成 Conventional Commits 信息，可编辑确认
- **AI 解冲突** — 冲突文件逐个交给 AI 合并，解决后自动 `git add` 并完成合并提交
- **自动建远程仓库** — 没有 origin 时，配置 GitHub Token 后自动创建私有仓库并推送
- **多仓库总览仪表盘** — KPI 统计、提交热力图、项目类型分布、可一键启动的项目卡片
- **运行状态管理** — 自动扫描项目、识别启动命令与运行端口，一键启停、实时日志，全程在应用内完成
- **一键回退历史版本** — 本地+远程提交时间线，任意版本一键回退（双重确认防误操作）
- **窗口置顶** — 一键置顶窗口，编码时始终可见
- **轻量** — Tauri 2 + 原生前端，约 10 MB 安装包，无打包器、无框架依赖

## 功能

| 模块 | 说明 |
| --- | --- |
| 总览仪表盘 | 全部项目的 KPI 卡片、近一年提交热力图、项目类型环形图、可筛选/搜索/启动服务器的项目卡片网格 |
| 项目侧栏 | 打开/克隆/拖拽添加仓库，自动识别项目图标与类型，状态摘要（分支、领先/落后、更改数）实时刷新 |
| 工作区面板 | 冲突/暂存/更改三分组展示，行内 diff 预览，单文件暂存/丢弃（两步确认防误操作），一键配置忽略规则（自动生成 .gitignore 候选） |
| 提交 | 只提交已暂存内容 → AI 自动生成提交信息 → 提交；也可一键全部暂存 |
| 推送 / 拉取 | 自动处理无上游分支；后台静默 fetch 保持状态新鲜 |
| AI 冲突解决 | 冲突文件交给 AI 合并（> 80 KB 需手动），自动 `git add` 并完成合并 |
| 历史时间线 | 本地+远程提交合并展示，一键回退到任意历史版本（双重确认） |
| 分支 | 切换分支，远程分支自动创建本地跟踪分支 |
| 运行面板 | 自动扫描并识别启动命令与运行端口（npm/django/make/cargo/go…），应用内一键启停、逐行日志、外部运行检测与安全停止 |
| 窗口 | 一键置顶保持可见，关闭时隐藏到系统托盘常驻 |

## 安装

### 从 Release 下载

前往 [Releases](https://github.com/Bavoch/hello-gitty/releases) 下载已发布的安装包。项目支持的格式为：

- macOS：`.dmg`
- Windows 10/11（x64）：`-setup.exe`

### 从源码构建

需要 [Node.js](https://nodejs.org/) 18+ 和 [Rust](https://www.rust-lang.org/)。Windows 还需要按 [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) 安装 Microsoft C++ Build Tools 与 WebView2。

```bash
git clone https://github.com/Bavoch/hello-gitty.git
cd hello-gitty
npm ci
npm run dev      # 开发模式
npm run build    # macOS 输出 .dmg；Windows 输出 NSIS setup.exe
```

## 使用

1. 打开应用 → 「选择仓库」选任意 git 文件夹（非仓库可现场初始化）
2. 右上角设置 → 填 API 地址 / Key / 模型 / 提交信息语言
3. 日常只用四个按钮：全部暂存 · 提交 · 推送 · 拉取

## 技术栈

- **Tauri 2** + Rust 后端（系统 git CLI，约 10 MB 安装包）
- 原生 HTML/CSS/JS 前端，无打包器
- AI 走 OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / 本地服务均可），Key 只存本机

## 结构

```
src/                前端（静态，无构建）
src-tauri/src/      后端
  git.rs            git CLI 封装 + porcelain v2 解析
  ai.rs             AI 提交信息 / 冲突解决
  runner.rs         服务器进程托管 / 端口探测
  config.rs         设置持久化
  lib.rs            Tauri 命令
```

## 项目状态

> ⚠️ **这是一个 100% 由 AI 开发的项目。**
>
> 从架构设计到代码实现、从功能迭代到问题修复，全部由 AI 完成，人工仅参与需求确认与验收。这意味着：
>
> - 代码可能存在**潜在的 bug 或未覆盖的边界情况**
> - 部分功能可能**未经充分的真实场景测试**
> - 请**谨慎用于生产环境**，重要数据请做好备份
>
> 尽管如此，我们仍在持续迭代中。如果你在使用过程中发现问题，欢迎提交 [Issue](https://github.com/Bavoch/hello-gitty/issues)——每一条反馈都是这个项目变得更好的动力 🐱

## 已知边界

- 冲突文件 > 80 KB 时 AI 无法处理，需手动解决（应用会提示）
- 远端需要凭证时，复用系统 git 凭据助手（macOS Keychain / Windows Credential Manager）
- 尊重仓库 hooks（`--no-verify` 不启用）

## 贡献

欢迎提交 Issue 和 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 协议

[MIT](LICENSE) © Bavoch

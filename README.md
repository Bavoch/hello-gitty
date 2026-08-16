<p align="center">
  <img src="src/favicon.png" alt="Hello Gitty" width="120" />
</p>

# Hello Gitty 🐱

[![Windows CI](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml/badge.svg)](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml)
[![Release](https://img.shields.io/github/v/release/Bavoch/hello-gitty)](https://github.com/Bavoch/hello-gitty/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Hello Gitty 是一款专为单人 AI 开发者打造的 Git 管理工具。

在使用 AI 进行开发时，我通常很少直接阅读代码，因此 IDE 中的大部分功能对我来说并不必要。很多时候，我只是想管理 Git、控制版本或撤销操作，却不得不打开庞大的 VsCode，只为使用左侧那一小块 Git 面板。与此同时，开发多个项目还意味着要打开多个 VsCode 窗口，不仅占用内存，也不够简洁优雅。

因此，我做了 Hello Gitty：一款专注于 Git 管理、轻量且独立的开发辅助工具。

## 核心亮点

- **专注 AI 开发工作流** — 自动生成 Conventional Commits 提交信息，并辅助处理 Git 冲突
- **多仓库统一管理** — 集中查看项目状态、提交活动与类型分布，快速切换和启动项目
- **内置运行环境管理** — 自动识别常见项目的启动方式与端口，在应用内管理开发服务器
- **安全可控的版本操作** — 支持查看本地与远程历史，并在确认后回退到任意版本
- **轻量且不打扰开发** — Tauri 2 + 原生前端，约 5–8 MB 安装包，支持窗口置顶与系统托盘
- **隐私优先** — Git 操作通过本机 CLI 完成，仓库内容默认保留在本机

## 功能

| 模块 | 说明 |
| --- | --- |
| 总览仪表盘 | 全部项目的 KPI 卡片、近一年提交热力图、项目类型环形图、可筛选/搜索/启动服务器的项目卡片网格 |
| 项目侧栏 | 打开/克隆/拖拽添加仓库，自动识别项目图标与类型，状态摘要（分支、领先/落后、更改数）实时刷新 |
| 工作区面板 | 冲突/暂存/更改三分组展示，行内 diff 预览，单文件暂存/丢弃（两步确认防误操作），一键配置忽略规则（自动生成 .gitignore 候选） |
| 提交 | 只提交已暂存内容 → AI 自动生成提交信息 → 提交；也可一键全部暂存 |
| 推送 / 拉取 | 自动处理无上游分支；后台静默 fetch 保持状态新鲜 |
| AI 冲突解决 | 冲突文件交给 AI 合并（> 80 KB 需手动），自动 `git add` 并完成合并 |
| 历史时间线 | 本地+远程提交合并展示，一键回退到任意历史版本（确认弹窗） |
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

1. 打开应用 → 「选择仓库」选任意本地项目文件夹，或者从远程地址克隆
2. 侧栏底部「设置」→ 填入 OpenAI 兼容接口的 API 地址、Key 和模型；不配置 Key 时仍可手动填写提交信息
3. 在工作区查看冲突、暂存区和未暂存改动，点击文件可预览 diff
4. 点击「提交」生成或填写提交信息，再用「推送 / 拉取」同步远程仓库
5. 在「运行」面板选择识别到的启动命令，查看日志并启停开发服务器

## 隐私与安全

- Git 操作通过本机的 `git` CLI 完成，仓库内容默认只留在本机。
- 使用 AI 生成功能或解决冲突时，相关 diff、近期提交信息或冲突文件内容会发送到你在设置中填写的 AI 接口。请确认该接口的隐私政策和数据处理方式。
- AI API Key 仅保存在本机配置中；GitHub Token 用于创建远程仓库和推送，请勿提交到仓库或公开分享。
- 发现安全漏洞请按 [安全策略](SECURITY.md) 私密报告；一般问题和功能建议可提交 [Issue](https://github.com/Bavoch/hello-gitty/issues)，也可以邮件联系 `hello@lumifold.top`。

## 技术栈

- **Tauri 2** + Rust 后端（系统 git CLI，约 5–8 MB 安装包）
- 原生 HTML/CSS/JS 前端，无打包器
- AI 走 OpenAI 兼容接口（OpenAI / DeepSeek / 本地服务均可），Key 只存本机

## 结构

```
src/                前端（静态，无构建）
src-tauri/src/      后端
  git.rs            git CLI 封装 + porcelain v2 解析
  ai.rs             AI 提交信息 / 冲突解决
  runner.rs         服务器进程托管 / 端口探测
  process.rs        跨平台进程启动（Windows 下抑制控制台窗口）
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

- 生成提交信息时，超过 60 KB 的 diff 会被截断后再交给 AI 分析
- 冲突文件 > 80 KB 时 AI 无法处理，需手动解决（应用会提示）
- 远端需要凭证时，复用系统 git 凭据助手（macOS Keychain / Windows Credential Manager）
- 尊重仓库 hooks（`--no-verify` 不启用）

## 贡献

欢迎提交 Issue 和 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 协议

[MIT](LICENSE) © Bavoch

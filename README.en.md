<p align="center">
  <img src="src/favicon.png" alt="Hello Gitty" width="120" />
</p>

# Hello Gitty 🐱

[![Windows CI](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml/badge.svg)](https://github.com/Bavoch/hello-gitty/actions/workflows/windows.yml)
[![Release](https://img.shields.io/github/v/release/Bavoch/hello-gitty)](https://github.com/Bavoch/hello-gitty/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) | English

Hello Gitty is a Git management tool built for solo AI-driven developers.

When developing with AI, I rarely read code directly, so most IDE features are unnecessary for me. Most of the time I just want to manage Git, control versions, or undo changes — yet I have to open heavyweight VS Code just for that small Git panel in the sidebar. Juggling multiple projects also means multiple VS Code windows: memory-hungry and anything but elegant.

So I built Hello Gitty: a lightweight, standalone companion focused on Git management.

## Highlights

- **Built for AI development workflows** — auto-generates Conventional Commits messages and assists with merge conflict resolution
- **Unified multi-repo management** — project status, commit activity, and type distribution at a glance; switch and launch projects quickly
- **Built-in dev server management** — detects launch commands and ports for common project types, so dev servers are managed inside the app
- **Safe, controlled version operations** — browse local and remote history, and reset to any version after confirmation
- **Lightweight and unobtrusive** — Tauri 2 + native frontend, ~5–8 MB installer, always-on-top window and system tray
- **Privacy first** — Git operations run through your local git CLI; repository content stays on your machine by default

## Features

| Module | Description |
| --- | --- |
| Overview dashboard | KPI cards across all projects, one-year commit heatmap, project-type donut chart, filterable/searchable project cards with one-click server launch |
| Project sidebar | Open/clone/drag-and-drop repositories, auto-detected project icons and types, live status summaries (branch, ahead/behind, change counts) |
| Workspace panel | Conflicts/staged/changes in three groups, inline diff preview, per-file stage/discard (two-step confirm), one-click ignore-rule setup with auto-generated `.gitignore` candidates |
| Commit | Commits staged changes only → AI-generated commit message → commit; or stage everything in one click |
| Push / Pull | Handles branches without an upstream automatically; silent background fetch keeps status fresh |
| AI conflict resolution | Conflict files are merged by AI (> 80 KB requires manual handling), then automatically `git add`-ed with the merge completed |
| History timeline | Combined local + remote commits; reset to any historical version with a confirmation dialog |
| Branches | Switch branches; remote branches automatically get local tracking branches |
| Run panel | Scans and detects launch commands and ports (npm/django/make/cargo/go…), start/stop inside the app, line-by-line logs, external-run detection and safe shutdown |
| Window | Always-on-top toggle to stay visible while coding; closing hides to the system tray |

## Installation

### Download from Releases

Go to [Releases](https://github.com/Bavoch/hello-gitty/releases) to download a published installer. Supported formats:

- macOS: `.dmg`
- Windows 10/11 (x64): `-setup.exe`

### Build from source

Requires [Node.js](https://nodejs.org/) 18+ and [Rust](https://www.rust-lang.org/). On Windows, also install Microsoft C++ Build Tools and WebView2 per the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```bash
git clone https://github.com/Bavoch/hello-gitty.git
cd hello-gitty
npm ci
npm run dev      # development mode (auto-reloads on save)
npm run build    # macOS: .dmg; Windows: NSIS setup.exe
```

## Getting Started

1. Open the app → "Select Repository" to pick any local project folder, or clone from a remote URL
2. "Settings" at the bottom of the sidebar → fill in an OpenAI-compatible API URL, key, and model; without a key you can still write commit messages manually
3. Review conflicts, staged, and unstaged changes in the workspace; click a file to preview its diff
4. Click "Commit" to generate or write a message, then "Push / Pull" to sync with the remote
5. In the "Run" panel, pick a detected launch command, watch the logs, and start/stop dev servers

## Privacy & Security

- Git operations run through your local `git` CLI; repository content stays on your machine by default.
- When using AI generation or conflict resolution, the relevant diffs, recent commit messages, or conflicted file contents are sent to the AI endpoint configured in Settings. Review that provider's privacy policy and data practices.
- The AI API key is stored only in the local config; the GitHub token is used to create remote repositories and push — never commit or share it publicly.
- Report security vulnerabilities privately via the [security policy](SECURITY.md); general issues and feature suggestions can go to [Issues](https://github.com/Bavoch/hello-gitty/issues) or email `hello@lumifold.top`.

## Tech Stack

- **Tauri 2** + Rust backend (system git CLI, ~5–8 MB installer)
- Native HTML/CSS/JS frontend, no bundler
- AI via OpenAI-compatible APIs (OpenAI / DeepSeek / local services all work); the key stays on your machine

## Structure

```
src/                Frontend (static, no build step)
src-tauri/src/      Backend
  git.rs            git CLI wrapper + porcelain v2 parsing
  ai.rs             AI commit messages / conflict resolution
  runner.rs         Server process supervision / port probing
  process.rs        Cross-platform process spawning (suppresses console windows on Windows)
  config.rs         Settings persistence
  lib.rs            Tauri commands
```

## Project Status

> ⚠️ **This project is 100% AI-developed.**
>
> From architecture design to implementation, feature iteration, and bug fixes, everything is done by AI; humans only confirm requirements and accept results. This means:
>
> - The code may contain **potential bugs or uncovered edge cases**
> - Some features may lack **thorough real-world testing**
> - **Use with caution in production** and keep backups of important data
>
> That said, development continues. If you run into problems, please open an [Issue](https://github.com/Bavoch/hello-gitty/issues) — every piece of feedback makes this project better 🐱

## Known Limitations

- When generating commit messages, diffs over 60 KB are truncated before being sent to the AI
- Conflict files over 80 KB cannot be handled by AI and need manual resolution (the app will prompt)
- Remote credentials are delegated to the system git credential helper (macOS Keychain / Windows Credential Manager)
- Repository hooks are respected (`--no-verify` is never used)

## Contributing

Issues and PRs are welcome! Please read [CONTRIBUTING.en.md](CONTRIBUTING.en.md) first.

## License

[MIT](LICENSE) © Bavoch

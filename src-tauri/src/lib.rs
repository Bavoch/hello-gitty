mod ai;
mod config;
mod git;

use ai::{AiConfig, ConflictOutcome};
use config::{Settings, SettingsStore};
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
struct OpResult {
    ok: bool,
    output: String,
}

fn op(r: Result<String, String>) -> OpResult {
    match r {
        Ok(output) => OpResult { ok: true, output },
        Err(output) => OpResult { ok: false, output },
    }
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Settings {
    SettingsStore::new(&app).load()
}

#[tauri::command]
fn settings_save(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    SettingsStore::new(&app).save(&settings)
}

#[tauri::command]
fn git_status(repo: String) -> git::RepoStatus {
    git::status(&repo)
}

/// 单仓库状态摘要(侧栏列表用)
#[derive(Serialize, Clone)]
struct RepoSummary {
    path: String,
    name: String,
    branch: Option<String>,
    ahead: i32,
    behind: i32,
    staged: usize,
    unstaged: usize,
    conflicts: usize,
    is_repo: bool,
}

fn summarize(path: &str) -> RepoSummary {
    let st = git::status(path);
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    RepoSummary {
        path: path.to_string(),
        name,
        branch: st.branch,
        ahead: st.ahead,
        behind: st.behind,
        staged: st.staged.len(),
        unstaged: st.unstaged.len() + st.untracked.len(),
        conflicts: st.conflicts.len(),
        is_repo: st.is_repo,
    }
}

/// 读取配置中的仓库列表并逐个生成状态摘要
#[tauri::command]
fn repos_status_all(app: tauri::AppHandle) -> Vec<RepoSummary> {
    let settings = SettingsStore::new(&app).load();
    settings.repos.iter().map(|p| summarize(p)).collect()
}

#[tauri::command]
fn repos_add(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    if !s.repos.iter().any(|p| p == &path) {
        s.repos.push(path.clone());
        store.save(&s)?;
    }
    Ok(s.repos)
}

#[tauri::command]
fn repos_remove(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    s.repos.retain(|p| p != &path);
    if s.last_repo.as_deref() == Some(path.as_str()) {
        s.last_repo = None;
    }
    store.save(&s)?;
    Ok(s.repos)
}

#[tauri::command]
fn repos_set_current(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    s.last_repo = Some(path);
    store.save(&s)
}

#[tauri::command]
fn git_init(repo: String) -> Result<(), String> {
    git::run_git(&repo, &["init", "-q"]).map(|_| ())
}

/// 文件夹选择走 Rust 侧 dialog 插件,前端只依赖 core.invoke
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("选择 Git 仓库文件夹")
        .blocking_pick_folder();
    match picked {
        Some(p) => match p.into_path() {
            Ok(path) => Ok(Some(path.to_string_lossy().to_string())),
            Err(e) => Err(format!("读取所选路径失败: {e}")),
        },
        None => Ok(None),
    }
}

/// 窗口置顶开关
#[tauri::command]
async fn window_set_always_on_top(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 历史列表(本地 + 远程上游)+ 当前 HEAD
#[derive(Serialize)]
struct RemoteHistory {
    name: String,
    commits: Vec<git::CommitInfo>,
}

#[derive(Serialize)]
struct History {
    head: Option<String>,
    commits: Vec<git::CommitInfo>,
    remote: Option<RemoteHistory>,
}

/// 内部 git 调用并行执行,减少切换/刷新延迟
#[tauri::command]
async fn git_history(repo: String) -> History {
    use tauri::async_runtime::spawn_blocking;
    let r1 = repo.clone();
    let r2 = repo.clone();
    let r3 = repo.clone();
    let head_job = spawn_blocking(move || git::head_hash(&r1));
    let upstream_job = spawn_blocking(move || git::upstream(&r2));
    let log_job = spawn_blocking(move || git::log(&r3, 20));
    let head = head_job.await.ok().flatten();
    let upstream = upstream_job.await.ok().flatten();
    let commits = log_job.await.unwrap_or_default();
    // 远程日志依赖 upstream 结果,只能串行
    let remote = match upstream {
        Some(name) => {
            let r4 = repo.clone();
            let n = name.clone();
            let commits = spawn_blocking(move || git::log_ref(&r4, &n, 20))
                .await
                .unwrap_or_default();
            Some(RemoteHistory { name, commits })
        }
        None => None,
    };
    History { head, commits, remote }
}

#[tauri::command]
async fn git_reset_hard(repo: String, hash: String) -> OpResult {
    op(
        tauri::async_runtime::spawn_blocking(move || git::reset_hard(&repo, &hash))
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
}

#[tauri::command]
fn git_stage_all(repo: String) -> Result<(), String> {
    git::stage_all(&repo)
}

#[tauri::command]
fn git_unstage_all(repo: String) -> Result<(), String> {
    git::unstage_all(&repo)
}

#[tauri::command]
fn git_stage_file(repo: String, path: String) -> Result<(), String> {
    git::stage_file(&repo, &path)
}

#[tauri::command]
fn git_unstage_file(repo: String, path: String) -> Result<(), String> {
    git::unstage_file(&repo, &path)
}

#[tauri::command]
async fn git_commit(repo: String, message: String) -> OpResult {
    op(tauri::async_runtime::spawn_blocking(move || git::commit(&repo, &message)).await.unwrap_or_else(|e| Err(e.to_string())))
}

#[tauri::command]
async fn git_push(app: tauri::AppHandle, repo: String) -> OpResult {
    // 已配置 origin 的仓库走普通推送
    if git::run_git(&repo, &["remote", "get-url", "origin"]).is_ok() {
        return op(
            tauri::async_runtime::spawn_blocking(move || git::push(&repo))
                .await
                .unwrap_or_else(|e| Err(e.to_string())),
        );
    }
    // 无远程仓库:配置了 GitHub Token 则自动创建私有仓库并推送
    let settings = SettingsStore::new(&app).load();
    let token = settings.github_token.unwrap_or_default();
    if token.trim().is_empty() {
        return op(Err(
            "还没有远程仓库。在设置页配置 GitHub Token 后,推送将自动创建远程仓库。".into(),
        ));
    }
    match auto_create_and_push(&repo, token.trim()).await {
        Ok(o) => op(Ok(format!("已自动创建远程仓库并推送\n{o}"))),
        Err(e) => op(Err(e)),
    }
}

/// 用 GitHub API 创建私有仓库 → 关联 origin → 推送
async fn auto_create_and_push(repo: &str, token: &str) -> Result<String, String> {
    let name = std::path::Path::new(repo)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "无法从路径确定仓库名".to_string())?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.github.com/user/repos")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "Hello-Gitty")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({ "name": name, "private": true, "auto_init": false }))
        .send()
        .await
        .map_err(|e| format!("请求 GitHub API 失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub 创建仓库失败({status}): {text}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "GitHub 响应解析失败".to_string())?;
    let clone_url = v
        .pointer("/clone_url")
        .and_then(|c| c.as_str())
        .ok_or_else(|| "仓库已创建但无法获取地址".to_string())?;

    // 关联 origin(已存在则更新地址)
    let _ = git::run_git(repo, &["remote", "remove", "origin"]);
    git::run_git(repo, &["remote", "add", "origin", clone_url])?;
    // push -u origin <branch>(git::push 内部处理无上游的情况)
    git::push(repo)
}

#[tauri::command]
async fn git_pull(repo: String) -> OpResult {
    op(tauri::async_runtime::spawn_blocking(move || git::pull(&repo)).await.unwrap_or_else(|e| Err(e.to_string())))
}

/// AI 解决冲突后调用:若处于合并中则自动完成合并提交
#[derive(Serialize)]
struct MergeResult {
    merged: bool,
    message: String,
}

#[tauri::command]
async fn git_finish_merge(repo: String) -> Result<MergeResult, String> {
    let (merged, message) = tauri::async_runtime::spawn_blocking(move || git::finish_merge(&repo))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))?;
    Ok(MergeResult { merged, message })
}

#[tauri::command]
async fn ai_commit_message(settings: AiConfig, repo: String) -> Result<String, String> {
    ai::generate_commit_message(&settings, &repo).await
}

#[tauri::command]
fn ai_presets() -> Vec<ai::PromptPreset> {
    ai::presets()
}

#[tauri::command]
async fn ai_resolve_file(settings: AiConfig, repo: String, path: String) -> Result<(), String> {
    ai::resolve_conflict_file(&settings, &repo, &path).await
}

#[tauri::command]
async fn ai_resolve_conflicts(
    app: tauri::AppHandle,
    settings: AiConfig,
    repo: String,
) -> Result<Vec<ConflictOutcome>, String> {
    let handle = app.clone();
    ai::resolve_all_conflicts(&settings, &repo, move |done, total, path| {
        let _ = handle.emit(
            "conflict-progress",
            serde_json::json!({ "done": done, "total": total, "path": path }),
        );
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动时聚焦已有窗口,不创建第二个实例
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            git_status,
            git_init,
            pick_folder,
            window_set_always_on_top,
            repos_status_all,
            repos_add,
            repos_remove,
            repos_set_current,
            git_stage_all,
            git_unstage_all,
            git_stage_file,
            git_unstage_file,
            git_commit,
            git_push,
            git_pull,
            git_finish_merge,
            git_history,
            git_reset_hard,
            ai_commit_message,
            ai_presets,
            ai_resolve_file,
            ai_resolve_conflicts,
        ])
        .on_window_event(|window, event| {
            // 关闭窗口不退出应用,隐藏到菜单栏托盘常驻
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show = MenuItem::with_id(app, "show", "显示 Hello Gitty", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::with_id("hello-gitty-tray")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 → 显示主窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Hello Gitty 启动失败");
}

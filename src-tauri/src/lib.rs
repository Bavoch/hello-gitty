mod ai;
mod checkpoint;
mod config;
mod git;
mod runner;

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

/// 单仓库状态摘要(侧栏列表/总览仪表盘用)
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
    /// 最近一次提交的 unix 时间戳(秒);非仓库/空仓库为 None
    last_commit_ts: Option<i64>,
    /// 项目图标(data URL),无图标则为 None
    icon: Option<String>,
}

/// 图标候选位置(相对项目根目录,按优先级;忽略大小写)
const ICON_LOCATIONS: &[&str] = &[
    "logo.png", "logo.jpg", "logo.jpeg", "logo.svg", "logo.webp", "logo.gif",
    "icon.png", "icon.jpg", "icon.svg", "icon.ico",
    "app-icon.png", "appicon.png", "app.png", "favicon.png",
    // 常见子目录位置(Tauri / 前端 / 桌面应用)
    "src-tauri/icons/icon.png",
    "src-tauri/icons/icon.ico",
    "assets/logo.png", "assets/icon.png", "assets/logo.svg", "assets/icon.svg",
    "src/assets/logo.png", "src/assets/icon.png", "src/assets/logo.svg",
    "public/favicon.ico", "public/logo.png", "public/logo.svg",
    "app/icon.png", "app/logo.png",
    // Chrome 扩展常见位置
    "icons/icon128.png", "icons/icon48.png", "icons/icon16.png",
    "icons/icon.png", "icons/logo.png",
    "images/icon128.png", "images/icon.png",
];

/// 读取图片文件转 base64 data URL;文件缺失/空/超限返回 None
fn read_icon_data_url(path: &std::path::Path) -> Option<String> {
    use base64::Engine as _;
    let data = std::fs::read(path).ok()?;
    if data.is_empty() || data.len() > 512 * 1024 {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

/// Chrome 扩展:解析 manifest.json 声明的 icons(或 action.default_icon)
fn chrome_manifest_icon(repo_path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(repo_path.join("manifest.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let rel = v
        .pointer("/icons/128")
        .or(v.pointer("/icons/48"))
        .or(v.pointer("/icons/16"))
        .and_then(|x| x.as_str())
        .or_else(|| {
            v.pointer("/action/default_icon/128")
                .or(v.pointer("/action/default_icon/48"))
                .or(v.pointer("/action/default_icon/16"))
                .and_then(|x| x.as_str())
        })
        .or_else(|| v.pointer("/action/default_icon").and_then(|x| x.as_str()));
    let rel = rel?;
    // 防目录穿越:拒绝含 .. 的相对路径
    if rel.contains("..") {
        return None;
    }
    read_icon_data_url(&repo_path.join(rel))
}

/// 读取项目图标文件,转为 base64 data URL;
/// 找不到真实图标时返回 None(前端渲染「首字符 + 稳定配色」字母头像)
fn repo_icon_data_url(repo: &str) -> Option<String> {
    let repo_path = std::path::Path::new(repo);
    // 1. Chrome 扩展 manifest.json 声明(最精确)
    if let Some(url) = chrome_manifest_icon(repo_path) {
        return Some(url);
    }
    // 2. 常见路径候选
    for loc in ICON_LOCATIONS {
        if let Some(url) = read_icon_data_url(&repo_path.join(loc)) {
            return Some(url);
        }
    }
    // 3. 无真实图标:返回 None,前端兜底字母头像
    None
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
        last_commit_ts: if st.is_repo { git::last_commit_ts(path) } else { None },
        icon: repo_icon_data_url(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_common_icon() {
        let dir = std::env::temp_dir().join(format!("hellogitty-icon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 空目录 → 无真实图标(None,前端渲染字母头像)
        assert!(repo_icon_data_url(dir.to_str().unwrap()).is_none(), "空目录应无图标");
        // 根目录 icon.png → data URL
        std::fs::write(dir.join("icon.png"), vec![0x89, 0x50, 0x4e, 0x47]).unwrap();
        let url = repo_icon_data_url(dir.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        std::fs::remove_file(dir.join("icon.png")).unwrap();
        // 子目录 src-tauri/icons/icon.png → 也能找到(Tauri 项目)
        std::fs::create_dir_all(dir.join("src-tauri/icons")).unwrap();
        std::fs::write(dir.join("src-tauri/icons/icon.png"), vec![0x89, 0x50, 0x4e, 0x47]).unwrap();
        let url = repo_icon_data_url(dir.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "子目录图标应被发现");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_chrome_extension_icon() {
        let dir = std::env::temp_dir().join(format!("hellogitty-chrome-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 按 manifest.json 声明 icons(128 优先)
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        std::fs::write(dir.join("icons/icon128.png"), vec![0x89, 0x50, 0x4e, 0x47]).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"name":"demo","version":"1.0","manifest_version":3,"icons":{"16":"icons/icon16.png","48":"icons/icon48.png","128":"icons/icon128.png"}}"#,
        )
        .unwrap();
        let url = repo_icon_data_url(dir.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "manifest icons 应被解析");
        // 路径含 .. 应被拒绝,无图标
        std::fs::remove_file(dir.join("icons/icon128.png")).unwrap(); // 清掉候选路径命中,确保返回 None
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"manifest_version":3,"icons":{"128":"../../etc/passwd"}}"#,
        )
        .unwrap();
        assert!(repo_icon_data_url(dir.to_str().unwrap()).is_none(), "穿越路径应被拒绝");
        std::fs::remove_dir_all(&dir).ok();
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

/// 读取项目根目录的 .gitignore 内容;文件不存在则返回空串
#[tauri::command]
fn gitignore_read(repo: String) -> Result<String, String> {
    let path = std::path::Path::new(&repo).join(".gitignore");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取 .gitignore 失败： {e}"))
}

/// 写入项目根目录的 .gitignore(覆盖),并自动将其暂存到 index,
/// 以免它本身作为未暂存改动残留在更改列表里。
#[tauri::command]
fn gitignore_write(repo: String, content: String) -> Result<(), String> {
    let path = std::path::Path::new(&repo).join(".gitignore");
    std::fs::write(&path, content).map_err(|e| format!("写入 .gitignore 失败： {e}"))?;
    git::stage_file(&repo, ".gitignore")
}

/// 克隆远程仓库到指定本地目录
#[tauri::command]
async fn git_clone(url: String, dest: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("git")
            .arg("clone")
            .arg(&url)
            .arg(&dest)
            .output()
            .map_err(|e| format!("无法执行 git clone： {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取单个文件的 diff(staged=true 取已暂存差异,否则取工作区差异)
#[tauri::command]
async fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if staged {
            git::run_git(&repo, &["diff", "--cached", "--no-color", "--no-ext-diff", "--", &path])
        } else {
            git::run_git(&repo, &["diff", "--no-color", "--no-ext-diff", "--", &path])
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
            Err(e) => Err(format!("读取所选路径失败： {e}")),
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

#[derive(Serialize, Default)]
struct History {
    head: Option<String>,
    commits: Vec<git::CommitInfo>,
    remote: Option<RemoteHistory>,
}

/// 内部 git 调用并行执行,减少切换/刷新延迟。
/// 本地/远程各取 20 条,但按 ahead/behind 调整窗口,使两侧下界对齐,
/// 避免"最早的提交只在远程显示"的窗口错位假象。
#[tauri::command]
async fn git_history(repo: String) -> History {
    use tauri::async_runtime::spawn_blocking;
    let r1 = repo.clone();
    let r2 = repo.clone();
    let head_job = spawn_blocking(move || git::head_hash(&r1));
    let upstream_job = spawn_blocking(move || git::upstream(&r2));
    let head = head_job.await.ok().flatten();
    let upstream = upstream_job.await.ok().flatten();
    // 远程日志来源:优先 upstream;未设置上游时兜底取第一个远程跟踪分支
    let remote_name = upstream.or_else(|| git::first_remote_branch(&repo));
    let (commits, remote) = match remote_name {
        Some(name) => {
            // 窗口对齐:本地起点偏移 ahead,远程起点偏移 behind,取相同跨度
            let ahead = git::ahead_count(&repo, &name);
            let behind = git::behind_count(&repo, &name);
            let local_n = ((20 + ahead).clamp(20, 500)) as usize;
            let remote_n = ((20 + behind).clamp(20, 500)) as usize;
            let r3 = repo.clone();
            let r4 = repo.clone();
            let n2 = name.clone();
            let local_job = spawn_blocking(move || git::log_ref(&r3, "HEAD", local_n));
            let remote_job = spawn_blocking(move || git::log_ref(&r4, &n2, remote_n));
            let commits = local_job.await.unwrap_or_default();
            let remote_commits = remote_job.await.unwrap_or_default();
            (commits, Some(RemoteHistory { name, commits: remote_commits }))
        }
        None => (git::log(&repo, 20), None),
    };
    History { head, commits, remote }
}

#[derive(Serialize)]
struct RefreshResult {
    status: git::RepoStatus,
    history: History,
    checkpoints: Vec<checkpoint::Checkpoint>,
}

/// 合并 status + history 的单次刷新命令:1 次 status 即拿到 branch/upstream/ahead/behind/head,
/// 再据此只跑必要的 log,省掉 git_history 里重复的 head_hash/upstream/ahead/behind 进程。
/// 切换仓库的 git 进程数从最多 7 次降到 3 次(无上游 2-3 次),显著降低 Windows 切换延迟。
#[tauri::command]
async fn git_refresh(repo: String) -> RefreshResult {
    use tauri::async_runtime::spawn_blocking;
    let r0 = repo.clone();
    let st = spawn_blocking(move || git::status(&r0)).await.unwrap_or_default();

    if !st.is_repo {
        return RefreshResult { status: st, history: History::default(), checkpoints: Vec::new() };
    }

    let head = st.head.clone();
    // upstream 取自 status(已解析);未设置上游时才兜底查第一个远程跟踪分支
    let remote_name = st.upstream.clone().or_else(|| git::first_remote_branch(&repo));
    let ahead = st.ahead;
    let behind = st.behind;

    let (commits, remote) = match remote_name {
        Some(name) => {
            let local_n = ((20 + ahead).clamp(20, 500)) as usize;
            let remote_n = ((20 + behind).clamp(20, 500)) as usize;
            let r3 = repo.clone();
            let r4 = repo.clone();
            let n2 = name.clone();
            let local_job = spawn_blocking(move || git::log_ref(&r3, "HEAD", local_n));
            let remote_job = spawn_blocking(move || git::log_ref(&r4, &n2, remote_n));
            let commits = local_job.await.unwrap_or_default();
            let remote_commits = remote_job.await.unwrap_or_default();
            (commits, Some(RemoteHistory { name, commits: remote_commits }))
        }
        None => {
            let r3 = repo.clone();
            (spawn_blocking(move || git::log(&r3, 20)).await.unwrap_or_default(), None)
        }
    };

    // 存档点列表随刷新一并返回(读一个小 json + 一次 rev-parse;容错,失败返回空)
    let r5 = repo.clone();
    let checkpoints = spawn_blocking(move || checkpoint::list(&r5)).await.unwrap_or_default();

    RefreshResult {
        status: st,
        history: History { head, commits, remote },
        checkpoints,
    }
}

#[tauri::command]
async fn git_reset_hard(repo: String, hash: String) -> OpResult {
    op(
        tauri::async_runtime::spawn_blocking(move || git::reset_hard(&repo, &hash))
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
}

/// 创建存档点(label 可为 null)
#[tauri::command]
async fn checkpoint_create(repo: String, label: Option<String>) -> Result<checkpoint::Checkpoint, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint::create(&repo, label))
        .await
        .map_err(|e| e.to_string())?
}

/// 读档:回到指定存档点的完整状态
#[tauri::command]
async fn checkpoint_restore(repo: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint::restore(&repo, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// 删除存档点(仅移除标记)
#[tauri::command]
async fn checkpoint_delete(repo: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint::delete(&repo, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct BranchList {
    current: Option<String>,
    locals: Vec<String>,
    remotes: Vec<String>,
}

#[tauri::command]
async fn git_branches(repo: String) -> BranchList {
    let r1 = repo.clone();
    let r2 = repo.clone();
    let r3 = repo.clone();
    let cur_job = tauri::async_runtime::spawn_blocking(move || {
        git::run_git(&r1, &["branch", "--show-current"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    let loc_job = tauri::async_runtime::spawn_blocking(move || git::local_branches(&r2));
    let rem_job = tauri::async_runtime::spawn_blocking(move || git::remote_branches(&r3));
    BranchList {
        current: cur_job.await.ok().flatten(),
        locals: loc_job.await.unwrap_or_default(),
        remotes: rem_job.await.unwrap_or_default(),
    }
}

#[tauri::command]
async fn git_checkout(repo: String, branch: String) -> OpResult {
    op(
        tauri::async_runtime::spawn_blocking(move || git::checkout(&repo, &branch))
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

/// 将单个文件从 git 跟踪中移除(保留工作区文件),使其在被加入 .gitignore 后
/// 能立即从状态列表消失。对未跟踪文件无害(--ignore-unmatch)。
#[tauri::command]
fn git_untrack_file(repo: String, path: String) -> Result<(), String> {
    git::untrack_file(&repo, &path)
}

#[tauri::command]
async fn git_discard_all(repo: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::discard_all_changes(&repo))
        .await
        .map_err(|e| e.to_string())?
}

/// 丢弃单个文件更改(已跟踪还原/未跟踪删除)
#[tauri::command]
async fn git_discard_file(repo: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::discard_file(&repo, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(repo: String, message: String) -> OpResult {
    op(tauri::async_runtime::spawn_blocking(move || git::commit(&repo, &message)).await.unwrap_or_else(|e| Err(e.to_string())))
}

#[tauri::command]
async fn git_push(repo: String) -> OpResult {
    // 已配置 origin 的仓库走普通推送
    if git::run_git(&repo, &["remote", "get-url", "origin"]).is_ok() {
        return op(
            tauri::async_runtime::spawn_blocking(move || git::push(&repo))
                .await
                .unwrap_or_else(|e| Err(e.to_string())),
        );
    }
    // 无远程仓库:按优先级探测凭据并自动创建
    let result = if gh_authed() {
        auto_create_via_gh(&repo)
    } else if let Some(token) = system_github_token() {
        auto_create_and_push(&repo, &token).await
    } else {
        // 引导用户去浏览器授权(前端识别该标记后打开认证页)
        Err("[NEED_AUTH]还没有远程仓库，也未找到可用的 GitHub 凭据".into())
    };
    match result {
        Ok(o) => op(Ok(format!("已自动创建远程仓库并推送\n{o}"))),
        Err(e) => op(Err(e)),
    }
}

/// 用户通过浏览器授权拿到 Token 后:存入系统钥匙串 → 创建远程 → 推送
#[tauri::command]
async fn git_push_with_token(repo: String, token: String) -> OpResult {
    let token = token.trim().to_string();
    if token.is_empty() {
        return op(Err("Token 不能为空".into()));
    }
    // 写入系统 git 凭据,后续推送自动复用
    let _ = credential_approve(&token);
    match auto_create_and_push(&repo, &token).await {
        Ok(o) => op(Ok(format!("已自动创建远程仓库并推送\n{o}"))),
        Err(e) => op(Err(e)),
    }
}

/// 在系统浏览器打开 GitHub 生成 Token 的页面(预填 repo scope)
#[tauri::command]
async fn open_auth_page() -> Result<(), String> {
    let url = "https://github.com/settings/tokens/new?scopes=repo&description=Hello+Gitty";
    let out = std::process::Command::new("open")
        .arg(url)
        .output()
        .map_err(|e| format!("无法打开浏览器： {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "无法打开浏览器： {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 把 Token 写入系统钥匙串(git credential approve)
fn credential_approve(token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = std::process::Command::new("git")
        .args(["credential", "approve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or("无法写入凭据")?
        .write_all(format!("protocol=https\nhost=github.com\nusername=git\npassword={token}\n\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let _ = child.wait();
    Ok(())
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
        .map_err(|e| format!("请求 GitHub API 失败： {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub 创建仓库失败（{status}）： {text}"));
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

/// 策略 2:GitHub CLI 已登录时,一行命令创建 + 关联 + 推送
fn auto_create_via_gh(repo: &str) -> Result<String, String> {
    let name = std::path::Path::new(repo)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "无法从路径确定仓库名".to_string())?;
    let out = run_gh(&[
        "repo", "create", &name, "--private", "--source", repo, "--remote", "origin", "--push",
    ])
    .map_err(|e| format!("GitHub CLI 创建失败： {e}"))?;
    // gh 的 --push 可能不设置上游,补一次 push -u,保证远程历史/后续推送正常
    if git::upstream(repo).is_none() {
        if let Some(branch) = git::status(repo).branch {
            let _ = git::run_git(repo, &["push", "-u", "origin", &branch]);
        }
    }
    Ok(out)
}

fn gh_authed() -> bool {
    run_gh(&["auth", "status"]).is_ok()
}

fn run_gh(args: &[&str]) -> Result<String, String> {
    for gh in ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        let out = std::process::Command::new(gh).args(args).output().ok();
        if let Some(o) = out {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            if o.status.success() {
                return Ok(text.trim().to_string());
            }
            return Err(format!(
                "{} {}",
                String::from_utf8_lossy(&o.stderr).trim(),
                text.trim()
            ));
        }
    }
    Err("未找到 gh 命令".into())
}

/// 策略 3:从系统 git 凭据(Keychain)中读取 GitHub token
fn system_github_token() -> Option<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = std::process::Command::new("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child
        .stdin
        .as_mut()?
        .write_all(b"protocol=https\nhost=github.com\n\n")
        .ok()?;
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let pw = text
        .lines()
        .find_map(|l| l.strip_prefix("password=").map(|p| p.to_string()))?;
    // 仅接受 token 形态的凭据(OAuth 形态的 password 无法用于 API)
    if pw.starts_with("ghp_") || pw.starts_with("github_pat_") || pw.starts_with("gho_") {
        Some(pw)
    } else {
        None
    }
}

#[tauri::command]
async fn git_pull(repo: String) -> OpResult {
    op(tauri::async_runtime::spawn_blocking(move || git::pull(&repo)).await.unwrap_or_else(|e| Err(e.to_string())))
}

/// 后台静默 fetch:更新远程跟踪分支;失败(无远程/无网络/未认证)返回 ok:false,
/// 由前端静默忽略,不打扰用户。
#[tauri::command]
async fn git_fetch(repo: String) -> OpResult {
    op(tauri::async_runtime::spawn_blocking(move || git::fetch(&repo)).await.unwrap_or_else(|e| Err(e.to_string())))
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

/// 流式生成提交信息:每收到一段就经 commit-stream 事件推送当前累积全文,返回最终全文
#[tauri::command]
async fn ai_commit_message_stream(
    app: tauri::AppHandle,
    settings: AiConfig,
    repo: String,
) -> Result<String, String> {
    let handle = app.clone();
    ai::generate_commit_message_stream(&settings, &repo, move |text| {
        let _ = handle.emit("commit-stream", serde_json::json!({ "text": text }));
    })
    .await
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

/// 智能识别仓库的全部「运行服务器」命令候选(按优先级排序)
#[tauri::command]
async fn server_detect(repo: String) -> Vec<runner::DetectResult> {
    let r = repo.clone();
    tauri::async_runtime::spawn_blocking(move || runner::detect_all(&r))
        .await
        .unwrap_or_default()
}

/// 启动一条长驻命令:stdout/stderr 逐行经 server-log 事件回推
#[tauri::command]
fn server_start(app: tauri::AppHandle, repo: String, command: String) -> Result<(), String> {
    runner::spawn_server(&app, &repo, &command)
}

/// 停止指定仓库的服务器
#[tauri::command]
fn server_stop(app: tauri::AppHandle, repo: String) -> Result<bool, String> {
    runner::stop(&app, &repo)
}

/// 查询仓库的服务器是否在运行
#[tauri::command]
fn server_status(app: tauri::AppHandle, repo: String) -> bool {
    runner::is_running(&app, &repo)
}

/// 检测仓库是否已在外部运行:探测其开发端口,返回被占用的端口列表(空 = 未检测到)
#[tauri::command]
async fn server_external_check(repo: String) -> Vec<runner::ProbedPort> {
    let r = repo.clone();
    tauri::async_runtime::spawn_blocking(move || runner::probe_ports(&r))
        .await
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动时聚焦已有窗口,不创建第二个实例
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(runner::RunRegistry::default())
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            git_status,
            git_init,
            gitignore_read,
            gitignore_write,
            git_clone,
            git_diff,
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
            git_untrack_file,
            git_discard_all,
            git_discard_file,
            git_commit,
            git_push,
            git_push_with_token,
            open_auth_page,
            git_pull,
            git_fetch,
            git_finish_merge,
            git_history,
            git_refresh,
            git_reset_hard,
            git_branches,
            git_checkout,
            checkpoint_create,
            checkpoint_restore,
            checkpoint_delete,
            ai_commit_message,
            ai_commit_message_stream,
            ai_presets,
            ai_resolve_file,
            ai_resolve_conflicts,
            server_detect,
            server_start,
            server_stop,
            server_status,
            server_external_check,
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
        .build(tauri::generate_context!())
        .expect("Hello Gitty 启动失败");
    // 应用真正退出时(含托盘「退出」、Cmd+Q、Dock 退出):统一关闭所有运行中的服务器,避免孤儿进程
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            runner::kill_all(app);
        }
    });
}

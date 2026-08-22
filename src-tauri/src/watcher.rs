use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct RepoWatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(serde::Serialize, Clone)]
struct RepoChanged {
    repo: String,
}

/// 开始监听当前项目目录。重复调用会先停止旧项目的监听，避免切换项目后仍收到旧事件。
#[tauri::command]
pub fn repo_watch_start(
    app: AppHandle,
    state: State<'_, RepoWatcherState>,
    repo: Option<String>,
) -> Result<(), String> {
    let mut active = state
        .watcher
        .lock()
        .map_err(|_| "项目文件监听器状态不可用".to_string())?;
    *active = None;

    let Some(repo) = repo.filter(|path| !path.trim().is_empty()) else {
        return Ok(());
    };
    let repo_for_event = repo.clone();
    let app_for_event = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            let Ok(event) = result else { return };
            if !is_relevant_event(&event) || event.paths.iter().all(|path| is_inside_git_dir(path))
            {
                return;
            }
            let _ = app_for_event.emit(
                "repo-files-changed",
                RepoChanged {
                    repo: repo_for_event.clone(),
                },
            );
        },
        Config::default(),
    )
    .map_err(|e| format!("无法监听项目目录：{e}"))?;
    watcher
        .watch(Path::new(&repo), RecursiveMode::Recursive)
        .map_err(|e| format!("无法监听项目目录：{e}"))?;
    *active = Some(watcher);
    Ok(())
}

fn is_relevant_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn is_inside_git_dir(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".git")
}

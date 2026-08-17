use crate::ai::AiConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[cfg(unix)]
fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub ai: AiConfig,
    #[serde(default)]
    pub last_repo: Option<String>,
    /// 仓库列表(多仓库管理,顺序即展示顺序)
    #[serde(default)]
    pub repos: Vec<String>,
    /// 每个仓库自定义的「运行服务器」命令(路径 -> 命令),未设置时由 runner 智能识别
    #[serde(default)]
    pub run_commands: std::collections::HashMap<String, String>,
    /// 每个仓库自定义的运行地址(路径 -> URL),未设置时用端口探测/项目文件推断
    #[serde(default)]
    pub run_urls: std::collections::HashMap<String, String>,
    /// 最近使用的运行命令历史(按使用顺序,新→旧),供下拉快捷选择
    #[serde(default)]
    pub run_history: Vec<String>,
    /// 右侧 diff 面板宽度(px),拖拽调整后持久化
    #[serde(default)]
    pub diff_width: Option<f64>,
    /// 底部运行日志面板高度(px),拖拽调整后持久化
    #[serde(default)]
    pub run_height: Option<f64>,
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        Self {
            path: dir.join("settings.json"),
        }
    }

    pub fn load(&self) -> Settings {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, s: &Settings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        replace_file(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::replace_file;

    #[test]
    fn replace_file_creates_and_overwrites_destination() {
        let dir = std::env::temp_dir().join(format!("hello-gitty-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("settings.json.tmp");
        let to = dir.join("settings.json");

        std::fs::write(&from, "first").unwrap();
        replace_file(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "first");

        std::fs::write(&from, "second").unwrap();
        replace_file(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "second");
        assert!(!from.exists());
        std::fs::remove_dir_all(dir).ok();
    }
}

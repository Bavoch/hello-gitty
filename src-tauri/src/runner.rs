//! 「运行服务器」:托管长驻子进程,逐行流式回推 stdout/stderr。
//!
//! 全程用 std::process::Command + std::thread 读取管道,不引入新依赖,
//! 与项目里 git.rs 的进程使用风格保持一致。

use serde::Serialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// 由 lib.rs 通过 app.manage 托管的进程表:仓库路径 -> 子进程
#[derive(Default)]
pub struct RunRegistry(pub Arc<Mutex<HashMap<String, Child>>>);

#[derive(Serialize, Clone)]
pub struct DetectResult {
    pub cmd: String,
    pub source: String,
}

/// 按优先级扫描仓库根目录,推断一条默认开发命令。失败返回 None。
pub fn detect(repo: &str) -> Option<DetectResult> {
    let root = Path::new(repo);
    if !root.is_dir() {
        return None;
    }

    // package.json 的 scripts
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for key in ["dev", "serve", "start"] {
                    if scripts.contains_key(key) {
                        return Some(DetectResult {
                            cmd: format!("npm run {key}"),
                            source: format!("package.json · scripts.{key}"),
                        });
                    }
                }
                // 有 scripts 但没命中上述键:取第一个
                if let Some(first) = scripts.keys().next() {
                    return Some(DetectResult {
                        cmd: format!("npm run {first}"),
                        source: format!("package.json · scripts.{first}"),
                    });
                }
            }
        }
    }

    // Django
    if root.join("manage.py").exists() {
        return Some(DetectResult {
            cmd: "python manage.py runserver".into(),
            source: "manage.py".into(),
        });
    }

    // docker compose
    if root.join("docker-compose.yml").exists()
        || root.join("docker-compose.yaml").exists()
        || root.join("compose.yml").exists()
        || root.join("compose.yaml").exists()
    {
        return Some(DetectResult {
            cmd: "docker compose up".into(),
            source: "docker-compose 文件".into(),
        });
    }

    // Makefile:优先 run / dev target,否则直接 make
    if root.join("Makefile").exists() {
        if let Ok(text) = std::fs::read_to_string(root.join("Makefile")) {
            for t in ["run", "dev", "serve", "start"] {
                // 目标行形如 "run:" (可能有前置空格 / 空格后跟冒号)
                if text.lines().any(|l| {
                    let l = l.trim_start();
                    l.starts_with(t) && l[t.len()..].trim_start().starts_with(':')
                }) {
                    return Some(DetectResult {
                        cmd: format!("make {t}"),
                        source: format!("Makefile · {t}"),
                    });
                }
            }
        }
        return Some(DetectResult {
            cmd: "make".into(),
            source: "Makefile".into(),
        });
    }

    // Rust
    if root.join("Cargo.toml").exists() {
        return Some(DetectResult {
            cmd: "cargo run".into(),
            source: "Cargo.toml".into(),
        });
    }

    // Go
    if root.join("go.mod").exists() {
        return Some(DetectResult {
            cmd: "go run .".into(),
            source: "go.mod".into(),
        });
    }

    // Node 入口
    for entry in ["index.js", "app.js", "server.js"] {
        if root.join(entry).exists() {
            return Some(DetectResult {
                cmd: "node .".into(),
                source: format!("{entry}"),
            });
        }
    }

    None
}

/// 启动一条长驻命令,在仓库目录下经 /bin/sh -c 执行;
/// stdout / stderr 逐行经 `server-log` 事件回推,两端 EOF 后经 `server-status` 通知已停止。
pub fn spawn_server(app: &AppHandle, repo: &str, command: &str) -> Result<(), String> {
    let root = Path::new(repo);
    if !root.is_dir() {
        return Err(format!("仓库目录不存在:{repo}"));
    }
    let command = command.trim();
    if command.is_empty() {
        return Err("运行命令为空".into());
    }

    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败:{e}"))?;

    // 取出管道交给读线程;child(含 pid)存入进程表用于 stop
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let registry = app.state::<RunRegistry>();
        let mut map = registry.inner().0.lock().map_err(|e| e.to_string())?;
        // 已有存活进程则拒绝重复启动
        if let Some(existing) = map.get_mut(repo) {
            if existing.try_wait().ok().flatten().is_none() {
                return Err("该项目已在运行,请先停止".into());
            }
        }
        map.insert(repo.to_string(), child);
    }

    // 计数:两条流都 EOF 后才认为进程输出结束,统一清理 + 通知
    let pending = Arc::new(Mutex::new(2u8));
    let app_out = app.clone();
    let repo_out = repo.to_string();
    if let Some(stream) = stdout {
        let pending = pending.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stream);
            for line in reader.lines().flatten() {
                let _ = app_out.emit(
                    "server-log",
                    serde_json::json!({ "repo": repo_out, "stream": "out", "line": line }),
                );
            }
            finalize(&pending, app_out, &repo_out);
        });
    } else {
        // 没有管道(异常),直接收尾
        let mut g = pending.lock().unwrap();
        *g = g.saturating_sub(1);
        drop(g);
        finalize(&pending, app.clone(), repo);
    }
    let app_err = app.clone();
    let repo_err = repo.to_string();
    if let Some(stream) = stderr {
        let pending = pending.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stream);
            for line in reader.lines().flatten() {
                let _ = app_err.emit(
                    "server-log",
                    serde_json::json!({ "repo": repo_err, "stream": "err", "line": line }),
                );
            }
            finalize(&pending, app_err, &repo_err);
        });
    } else {
        let mut g = pending.lock().unwrap();
        *g = g.saturating_sub(1);
        drop(g);
        finalize(&pending, app.clone(), repo);
    }

    Ok(())
}

/// 计数归零时清理进程表条目并发送停止事件(尽力取出退出码)
fn finalize(pending: &Mutex<u8>, app: AppHandle, repo: &str) {
    let done = {
        let mut g = match pending.lock() { Ok(g) => g, Err(_) => return };
        if *g > 0 { *g -= 1; }
        *g == 0
    };
    if !done {
        return;
    }
    let code = {
        let registry = app.state::<RunRegistry>();
        let mut map = registry.inner().0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = map.remove(repo) {
            child.try_wait().ok().flatten().and_then(|s| s.code())
        } else {
            None
        }
    };
    let _ = app.emit(
        "server-status",
        serde_json::json!({ "repo": repo, "running": false, "code": code }),
    );
}

/// 停止指定仓库的服务器(若存在且存活)。返回是否实际操作过。
pub fn stop(app: &AppHandle, repo: &str) -> Result<bool, String> {
    let registry = app.state::<RunRegistry>();
    let mut map = registry.inner().0.lock().map_err(|e| e.to_string())?;
    let Some(mut child) = map.remove(repo) else {
        return Ok(false);
    };
    // 已退出就无需 kill
    if child.try_wait().ok().flatten().is_some() {
        return Ok(false);
    }
    let killed = child.kill().is_ok();
    let _ = child.wait(); // 回收,避免僵尸
    drop(map);
    if killed {
        let _ = app.emit(
            "server-status",
            serde_json::json!({ "repo": repo, "running": false, "code": null }),
        );
    }
    Ok(killed)
}

/// 该仓库是否存在存活的服务器进程
pub fn is_running(app: &AppHandle, repo: &str) -> bool {
    let registry = app.state::<RunRegistry>();
    let Ok(mut map) = registry.inner().0.lock() else { return false };
    if let Some(child) = map.get_mut(repo) {
        matches!(child.try_wait(), Ok(None))
    } else {
        false
    }
}

/// 退出应用前统一清理,避免孤儿进程
pub fn kill_all(app: &AppHandle) {
    let registry = app.state::<RunRegistry>();
    let mut map = registry.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    for (_, mut child) in map.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::detect;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    // 每个测试一个独立临时目录,目录名带 pid + 自增序号,避免并发/重入冲突
    fn tmpdir(name: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("hg-runner-{}-{}-{}", std::process::id(), name, n));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn detect_package_json_dev() {
        let d = tmpdir("pkg");
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"start":"x","dev":"vite","build":"tsc"}}"#,
        )
        .unwrap();
        let r = detect(d.to_str().unwrap()).expect("应识别到命令");
        assert_eq!(r.cmd, "npm run dev"); // dev 优先级高于 start
        assert!(r.source.contains("dev"));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_manage_py() {
        let d = tmpdir("django");
        fs::write(d.join("manage.py"), "").unwrap();
        let r = detect(d.to_str().unwrap()).unwrap();
        assert_eq!(r.cmd, "python manage.py runserver");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_cargo() {
        let d = tmpdir("rust");
        fs::write(d.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        let r = detect(d.to_str().unwrap()).unwrap();
        assert_eq!(r.cmd, "cargo run");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_makefile_run_target() {
        let d = tmpdir("make");
        fs::write(d.join("Makefile"), "build:\n\techo hi\n\nrun:\n\t./app\n").unwrap();
        let r = detect(d.to_str().unwrap()).unwrap();
        assert_eq!(r.cmd, "make run");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_empty_dir_none() {
        let d = tmpdir("empty");
        assert!(detect(d.to_str().unwrap()).is_none());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_nonexistent_path_none() {
        assert!(detect("/no/such/path/xyz/__hg").is_none());
    }
}

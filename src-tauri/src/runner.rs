//! 「运行服务器」:托管长驻子进程,逐行流式回推 stdout/stderr。
//!
//! 全程用 std::process::Command + std::thread 读取管道,不引入新依赖,
//! 与项目里 git.rs 的进程使用风格保持一致。

use serde::Serialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 由 lib.rs 通过 app.manage 托管的进程表:仓库路径 -> 子进程
#[derive(Default)]
pub struct RunRegistry(pub Arc<Mutex<HashMap<String, Child>>>);

#[derive(Serialize, Clone)]
pub struct DetectResult {
    pub cmd: String,
    pub source: String,
}

/// 按优先级扫描仓库根目录,收集全部可行的「运行服务器」命令候选(按发现顺序,cmd 去重)。
pub fn detect_all(repo: &str) -> Vec<DetectResult> {
    let root = Path::new(repo);
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<DetectResult> = Vec::new();
    let mut push = |cmd: String, source: String| {
        if !out.iter().any(|d| d.cmd == cmd) {
            out.push(DetectResult { cmd, source });
        }
    };

    // package.json 的 scripts:收集常见运行类键(保持优先顺序),全无则取第一个 script 兜底
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                let mut found = false;
                for key in ["dev", "serve", "start", "preview", "watch", "run", "debug"] {
                    if scripts.contains_key(key) {
                        push(format!("npm run {key}"), format!("package.json · scripts.{key}"));
                        found = true;
                    }
                }
                // Tauri 项目:scripts.tauri 惯例调用 tauri CLI,常用子命令是 dev
                if scripts.contains_key("tauri") {
                    push("npm run tauri dev".into(), "package.json · scripts.tauri (dev)".into());
                    found = true;
                }
                // 带前缀的运行类键(dev:web / start:client / serve:api…),按键名排序保证确定性
                let mut prefixed: Vec<&String> = scripts
                    .keys()
                    .filter(|k| ["dev:", "start:", "serve:", "watch:", "preview:"].iter().any(|p| k.starts_with(p)))
                    .collect();
                prefixed.sort();
                for k in prefixed {
                    push(format!("npm run {k}"), format!("package.json · scripts.{k}"));
                    found = true;
                }
                if !found {
                    if let Some(first) = scripts.keys().next() {
                        push(format!("npm run {first}"), format!("package.json · scripts.{first}"));
                    }
                }
            }
        }
    }

    // Django
    if root.join("manage.py").exists() {
        push("python manage.py runserver".into(), "manage.py".into());
    }

    // docker compose
    if root.join("docker-compose.yml").exists()
        || root.join("docker-compose.yaml").exists()
        || root.join("compose.yml").exists()
        || root.join("compose.yaml").exists()
    {
        push("docker compose up".into(), "docker-compose 文件".into());
    }

    // Makefile:收集 run / dev / serve / start target,无命中则直接 make
    if root.join("Makefile").exists() {
        if let Ok(text) = std::fs::read_to_string(root.join("Makefile")) {
            let mut found = false;
            for t in ["run", "dev", "serve", "start"] {
                // 目标行形如 "run:" (可能有前置空格 / 空格后跟冒号)
                if text.lines().any(|l| {
                    let l = l.trim_start();
                    l.starts_with(t) && l[t.len()..].trim_start().starts_with(':')
                }) {
                    push(format!("make {t}"), format!("Makefile · {t}"));
                    found = true;
                }
            }
            if !found {
                push("make".into(), "Makefile".into());
            }
        } else {
            push("make".into(), "Makefile".into());
        }
    }

    // Rust
    if root.join("Cargo.toml").exists() {
        push("cargo run".into(), "Cargo.toml".into());
    }

    // Go
    if root.join("go.mod").exists() {
        push("go run .".into(), "go.mod".into());
    }

    // Node 入口
    for entry in ["index.js", "app.js", "server.js"] {
        if root.join(entry).exists() {
            push("node .".into(), entry.into());
            break;
        }
    }

    out
}

/// 单值入口:返回候选列表的第一个(供测试与未来单候选场景复用)
#[allow(dead_code)]
pub fn detect(repo: &str) -> Option<DetectResult> {
    detect_all(repo).into_iter().next()
}

/// 端口探测结果:端口被占用即说明项目可能在外部(其他应用/终端)已启动
#[derive(Serialize, Clone)]
pub struct ProbedPort {
    pub port: u16,
    /// explicit: 命令/配置显式指定; default: 框架默认端口兜底(可能误报)
    pub source: String,
}

/// 从命令文本提取显式端口(--port=N / -p=N / --port N / -p N / PORT=N 五种写法)
fn extract_ports(cmd: &str) -> Vec<u16> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        let port = if let Some(rest) = t.strip_prefix("--port=") {
            rest.parse().ok()
        } else if let Some(rest) = t.strip_prefix("-p=") {
            rest.parse().ok()
        } else if t == "--port" || t == "-p" {
            tokens.get(i + 1).and_then(|n| n.trim_end_matches(',').parse().ok())
        } else if let Some(rest) = t.strip_prefix("PORT=") {
            rest.parse().ok()
        } else {
            None
        };
        if let Some(p) = port {
            if p > 0 {
                out.push(p);
            }
        }
        i += 1;
    }
    out
}

/// 从 vite.config 提取 server.port(扫描 "port" 冒号数字;该文件里 port 基本只出现在 server 块)
fn extract_config_port(text: &str) -> Option<u16> {
    for (i, _) in text.match_indices("port") {
        let rest = text[i + 4..].trim_start();
        if let Some(rest) = rest.strip_prefix(':') {
            let num: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !num.is_empty() {
                if let Ok(p) = num.parse::<u16>() {
                    if p > 0 {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// 从 tauri.conf.json 的 devUrl(http://host:port) 提取端口
fn extract_url_port(text: &str) -> Option<u16> {
    for scheme in ["http://", "https://"] {
        let mut from = 0;
        while let Some(pos) = text[from..].find(scheme) {
            let start = from + pos + scheme.len();
            if let Some(colon) = text[start..].find(':') {
                let after = start + colon + 1;
                let num: String = text[after..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if !num.is_empty() {
                    if let Ok(p) = num.parse::<u16>() {
                        if p > 0 {
                            return Some(p);
                        }
                    }
                }
            }
            from = start;
        }
    }
    None
}

/// 框架默认开发端口(无显式端口时兜底,可能误报但比漏报强)
fn default_port(script_text: &str, root: &Path) -> Option<u16> {
    if script_text.contains("vite") {
        return Some(5173);
    }
    if script_text.contains("next dev") || script_text.contains("react-scripts") || script_text.contains("nuxt") {
        return Some(3000);
    }
    if script_text.contains("webpack") {
        return Some(8080);
    }
    if root.join("manage.py").exists() || script_text.contains("http.server") {
        return Some(8000);
    }
    if script_text.contains(" serve ") {
        return Some(3000);
    }
    None
}

/// 收集仓库可能监听的开发端口:显式(命令参数/配置文件)优先,无显式则框架默认兜底。返回 (端口, 来源)。
pub fn collect_ports(repo: &str) -> Vec<(u16, &'static str)> {
    let root = Path::new(repo);
    let mut cands: Vec<(u16, &'static str)> = Vec::new();

    // scripts 原文里的显式端口(命令候选只保留 `npm run dev` 包裹,端口在原文里)
    let mut script_text = String::new();
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for (_, cmd) in scripts {
                    if let Some(c) = cmd.as_str() {
                        for p in extract_ports(c) {
                            cands.push((p, "explicit"));
                        }
                        script_text.push_str(c);
                        script_text.push(' ');
                    }
                }
            }
        }
    }

    // 配置文件显式端口:tauri devUrl(dev 前端端口) 与 vite.config server.port
    for conf in ["tauri.conf.json", "src-tauri/tauri.conf.json"] {
        if let Ok(text) = std::fs::read_to_string(root.join(conf)) {
            if let Some(p) = extract_url_port(&text) {
                cands.push((p, "explicit"));
            }
        }
    }
    for conf in ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"] {
        if let Ok(text) = std::fs::read_to_string(root.join(conf)) {
            if let Some(p) = extract_config_port(&text) {
                cands.push((p, "explicit"));
            }
        }
    }

    // 无显式端口时才兜底框架默认(可能误报,但比漏报强)
    if cands.is_empty() {
        if let Some(p) = default_port(&script_text, root) {
            cands.push((p, "default"));
        }
    }

    // 去重保序
    let mut out: Vec<(u16, &'static str)> = Vec::new();
    for c in cands {
        if !out.iter().any(|(x, _)| *x == c.0) {
            out.push(c);
        }
    }
    out
}

/// 探测 localhost 上某端口是否有进程监听(IPv4+IPv6 都试;IP 字面量直连,不受系统代理劫持域名影响)
pub fn probe_port(port: u16) -> bool {
    for host in ["127.0.0.1", "[::1]"] {
        if let Ok(sa) = format!("{host}:{port}").parse::<std::net::SocketAddr>() {
            if let Ok(s) = TcpStream::connect_timeout(&sa, Duration::from_millis(150)) {
                drop(s);
                return true;
            }
        }
    }
    false
}

/// 探测仓库的显式/默认端口,返回实际被占用的端口(即「已在外部运行」的证据)
pub fn probe_ports(repo: &str) -> Vec<ProbedPort> {
    collect_ports(repo)
        .into_iter()
        .filter(|(p, _)| probe_port(*p))
        .map(|(port, source)| ProbedPort { port, source: source.to_string() })
        .collect()
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

    // 独立进程组启动:stop 时 killpg 才能连带杀掉 sh 的实际子进程(如 npm/node)
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .current_dir(repo)
        .process_group(0)
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
/// 进程以独立进程组启动,这里 killpg 整个组,确保 npm/node 等实际命令一并退出。
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
    let pgid = child.id() as i32;
    // 先 SIGTERM 优雅退出,最多等 2s;仍存活再 SIGKILL 兜底
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if child.try_wait().ok().flatten().is_none() {
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
        let _ = child.wait(); // 回收,避免僵尸
    }
    drop(map);
    let _ = app.emit(
        "server-status",
        serde_json::json!({ "repo": repo, "running": false, "code": null }),
    );
    Ok(true)
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
    use super::{collect_ports, detect, detect_all, extract_ports, probe_port};
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

    #[test]
    fn detect_all_package_json_multiple() {
        let d = tmpdir("pkgall");
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"start":"x","dev":"vite","serve":"vite --host","build":"tsc"}}"#,
        )
        .unwrap();
        let r = detect_all(d.to_str().unwrap());
        let cmds: Vec<_> = r.iter().map(|x| x.cmd.as_str()).collect();
        assert_eq!(cmds, ["npm run dev", "npm run serve", "npm run start"]); // 按 dev→serve→start 顺序
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_all_first_script_fallback() {
        let d = tmpdir("pkgfallback");
        fs::write(d.join("package.json"), r#"{"scripts":{"build":"tsc"}}"#).unwrap();
        let r = detect_all(d.to_str().unwrap());
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].cmd, "npm run build"); // 无运行类键时取第一个兜底
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_all_mixed_npm_and_make() {
        let d = tmpdir("mixed");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join("Makefile"), "run:\n\techo hi\n").unwrap();
        let r = detect_all(d.to_str().unwrap());
        let cmds: Vec<_> = r.iter().map(|x| x.cmd.as_str()).collect();
        assert_eq!(cmds, ["npm run dev", "make run"]); // 两种来源并存时全部收集
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_all_makefile_multiple_targets() {
        let d = tmpdir("maketargets");
        fs::write(d.join("Makefile"), "dev:\n\techo dev\n\nrun:\n\techo run\n").unwrap();
        let r = detect_all(d.to_str().unwrap());
        let cmds: Vec<_> = r.iter().map(|x| x.cmd.as_str()).collect();
        assert_eq!(cmds, ["make run", "make dev"]); // 按 run→dev 优先级排序
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_all_tauri_project() {
        let d = tmpdir("tauri");
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"dev":"vite --port 1420","build":"vite build","preview":"vite preview","tauri":"tauri"}}"#,
        )
        .unwrap();
        let r = detect_all(d.to_str().unwrap());
        let cmds: Vec<_> = r.iter().map(|x| x.cmd.as_str()).collect();
        assert_eq!(cmds, ["npm run dev", "npm run preview", "npm run tauri dev"]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detect_all_prefixed_scripts() {
        let d = tmpdir("prefix");
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"dev:web":"vite --port 5173","start:api":"tsx api/index.ts","build":"tsc"}}"#,
        )
        .unwrap();
        let r = detect_all(d.to_str().unwrap());
        let cmds: Vec<_> = r.iter().map(|x| x.cmd.as_str()).collect();
        assert_eq!(cmds, ["npm run dev:web", "npm run start:api"]); // 前缀键按名排序
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn extract_ports_from_cmd() {
        assert_eq!(extract_ports("vite --port 1420"), vec![1420]);
        assert_eq!(extract_ports("vite --port=5173"), vec![5173]);
        assert_eq!(extract_ports("next dev -p 8080"), vec![8080]);
        assert_eq!(extract_ports("PORT=3000 node app.js"), vec![3000]);
        assert!(extract_ports("vite build").is_empty());
    }

    #[test]
    fn collect_ports_tauri_devurl() {
        let d = tmpdir("portstauri");
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite --port 1420","tauri":"tauri"}}"#).unwrap();
        fs::write(d.join("src-tauri/tauri.conf.json"), r#"{"devUrl":"http://localhost:1421"}"#).unwrap();
        let r = collect_ports(d.to_str().unwrap());
        let ports: Vec<u16> = r.iter().map(|x| x.0).collect();
        assert_eq!(ports, vec![1420, 1421]); // 命令端口 + devUrl 端口都解析
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn collect_ports_vite_default() {
        let d = tmpdir("portsvite");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        let r = collect_ports(d.to_str().unwrap());
        assert_eq!(r, vec![(5173, "default")]); // 无显式端口 → 框架默认兜底
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn collect_ports_vite_config() {
        let d = tmpdir("portsvcfg");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join("vite.config.ts"), "export default { server: { port: 4000 } }").unwrap();
        let r = collect_ports(d.to_str().unwrap());
        let ports: Vec<u16> = r.iter().map(|x| x.0).collect();
        assert_eq!(ports, vec![4000]); // vite.config 显式端口优先于默认兜底
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn collect_ports_empty_none() {
        let d = tmpdir("portsnone");
        assert!(collect_ports(d.to_str().unwrap()).is_empty()); // 无 package.json / 配置文件 → 无端口
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn probe_port_listening_and_free() {
        use std::net::{TcpListener, UdpSocket};
        // 有进程监听 → 能探测到
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(probe_port(port));
        drop(l);
        // 空闲端口 → 探测不到(UDP 拿的随机端口无 TCP TIME_WAIT 残留,避免时序抖动)
        let u = UdpSocket::bind("127.0.0.1:0").unwrap();
        let free = u.local_addr().unwrap().port();
        drop(u);
        assert!(!probe_port(free));
    }
}

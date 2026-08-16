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

/// 由 lib.rs 通过 app.manage 托管的进程表:仓库路径 -> (运行命令, 子进程)
/// 记录命令用于 server_status 恢复前端对应命令的运行态
#[derive(Default)]
pub struct RunRegistry(pub Arc<Mutex<HashMap<String, (String, Child)>>>);

#[derive(Serialize, Clone)]
pub struct DetectResult {
    pub cmd: String,
    pub source: String,
    /// 是否长驻服务(可停止):dev/serve/start 等运行类命令可停;
    /// build/test 等一次性命令跑完自退,前端不提供停止按钮
    pub stoppable: bool,
    /// 该命令隐含的开发端口(scripts 值里的显式 --port 等),无则空。
    /// 供前端把外部占用的端口归因到具体命令,点亮对应 chip 并提供停止
    pub ports: Vec<u16>,
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    /// 运行中的命令(仅 running=true 时有值),用于前端恢复对应命令的运行态
    pub command: Option<String>,
}

/// 按优先级扫描仓库根目录,收集全部可行的「运行服务器」命令候选(按发现顺序,cmd 去重)。
pub fn detect_all(repo: &str) -> Vec<DetectResult> {
    let root = Path::new(repo);
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<DetectResult> = Vec::new();
    let mut push = |cmd: String, source: String, stoppable: bool, ports: Vec<u16>| {
        if !out.iter().any(|d| d.cmd == cmd) {
            out.push(DetectResult {
                cmd,
                source,
                stoppable,
                ports,
            });
        }
    };

    // package.json 的 scripts:收集常见运行类键(保持优先顺序),全无则取第一个 script 兜底
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                // 命令隐含端口:scripts 值里的显式 --port(外部运行归因用)
                let ports_of = |k: &str| -> Vec<u16> {
                    scripts
                        .get(k)
                        .and_then(|c| c.as_str())
                        .map(extract_ports)
                        .unwrap_or_default()
                };
                let mut found = false;
                for key in ["dev", "serve", "start", "preview", "watch", "run", "debug"] {
                    if scripts.contains_key(key) {
                        push(
                            format!("npm run {key}"),
                            format!("package.json · scripts.{key}"),
                            true,
                            ports_of(key),
                        );
                        found = true;
                    }
                }
                // Tauri 项目:scripts.tauri 惯例调用 tauri CLI,常用子命令是 dev
                if scripts.contains_key("tauri") {
                    push(
                        "npm run tauri dev".into(),
                        "package.json · scripts.tauri (dev)".into(),
                        true,
                        Vec::new(),
                    );
                    found = true;
                }
                // 带前缀的运行类键(dev:web / start:client / serve:api…),按键名排序保证确定性
                let mut prefixed: Vec<&String> = scripts
                    .keys()
                    .filter(|k| {
                        ["dev:", "start:", "serve:", "watch:", "preview:"]
                            .iter()
                            .any(|p| k.starts_with(p))
                    })
                    .collect();
                prefixed.sort();
                for k in prefixed {
                    push(
                        format!("npm run {k}"),
                        format!("package.json · scripts.{k}"),
                        true,
                        ports_of(k),
                    );
                    found = true;
                }
                if !found {
                    // 无运行类键时取第一个 script 兜底:大概率是 build/test 等一次性命令,跑完自退
                    if let Some(first) = scripts.keys().next() {
                        push(
                            format!("npm run {first}"),
                            format!("package.json · scripts.{first}"),
                            false,
                            ports_of(first),
                        );
                    }
                }
            }
        }
    }

    // Django
    if root.join("manage.py").exists() {
        push(
            "python manage.py runserver".into(),
            "manage.py".into(),
            true,
            Vec::new(),
        );
    }

    // docker compose
    if root.join("docker-compose.yml").exists()
        || root.join("docker-compose.yaml").exists()
        || root.join("compose.yml").exists()
        || root.join("compose.yaml").exists()
    {
        push(
            "docker compose up".into(),
            "docker-compose 文件".into(),
            true,
            Vec::new(),
        );
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
                    push(format!("make {t}"), format!("Makefile · {t}"), true, Vec::new());
                    found = true;
                }
            }
            if !found {
                // 默认 target 多为构建,视为一次性
                push("make".into(), "Makefile".into(), false, Vec::new());
            }
        } else {
            push("make".into(), "Makefile".into(), false, Vec::new());
        }
    }

    // Rust
    if root.join("Cargo.toml").exists() {
        push("cargo run".into(), "Cargo.toml".into(), true, Vec::new());
    }

    // Go
    if root.join("go.mod").exists() {
        push("go run .".into(), "go.mod".into(), true, Vec::new());
    }

    // Node 入口
    for entry in ["index.js", "app.js", "server.js"] {
        if root.join(entry).exists() {
            push("node .".into(), entry.into(), true, Vec::new());
            break;
        }
    }

    // vite.config 的 server.port 是开发服务器端口,归到最高优先级的运行命令:
    // dev 脚本可能经 node 脚本间接启动 vite(scripts 里无显式 --port),
    // 缺这条归因会把外部占用端口误标到恰好写了相同端口的 preview 等命令上。
    // 该命令已有显式端口时跳过(CLI --port 优先于配置文件,语义不同)
    for conf in ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"] {
        if let Ok(text) = std::fs::read_to_string(root.join(conf)) {
            if let Some(p) = extract_config_port(&text) {
                if let Some(first) = out.iter_mut().find(|d| d.stoppable && d.ports.is_empty()) {
                    first.ports.push(p);
                }
            }
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
    /// 端口来源语义:
    /// - "web": Web 开发服务器端口(vite.config 等),可在浏览器打开
    /// - "tauri": Tauri 桌面应用 devUrl 端口,WebView 内部资源用,浏览器打开无意义
    /// - "explicit": scripts 里显式 --port 参数(通常也是 Web 服务)
    /// - "default": 框架默认端口兜底(可能误报)
    pub source: String,
    /// 占用该端口的监听进程 PID。仅当进程工作目录属于该仓库时才有值;
    /// None = 无法确认归属,前端不应提供停止(避免误杀无关进程)
    pub pid: Option<i32>,
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
            tokens
                .get(i + 1)
                .and_then(|n| n.trim_end_matches(',').parse().ok())
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
    if script_text.contains("next dev")
        || script_text.contains("react-scripts")
        || script_text.contains("nuxt")
    {
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
                // Tauri 桌面应用的 devUrl 是 WebView 内部加载的资源端口,
                // 在浏览器打开没有意义,单独标记供前端不显示可点击地址
                cands.push((p, "tauri"));
            }
        }
    }
    for conf in [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.mts",
    ] {
        if let Ok(text) = std::fs::read_to_string(root.join(conf)) {
            if let Some(p) = extract_config_port(&text) {
                cands.push((p, "web"));
            }
        }
    }

    // 无显式端口时才兜底框架默认(可能误报,但比漏报强)
    if cands.is_empty() {
        if let Some(p) = default_port(&script_text, root) {
            cands.push((p, "default"));
        }
    }

    // 去重保序;同端口多来源时「tauri」优先(桌面应用的 devUrl 端口,
    // 即使 scripts 里也写了 --port,它最终仍是 WebView 内部资源,不提供浏览器地址)
    let mut out: Vec<(u16, &'static str)> = Vec::new();
    for c in cands {
        if let Some((_, prev)) = out.iter_mut().find(|(x, _)| *x == c.0) {
            if c.1 == "tauri" {
                *prev = "tauri";
            }
        } else {
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

/// 探测仓库的显式/默认端口(+ 前端传入的自定义端口),返回实际被占用的端口(即「已在外部运行」的证据)。
/// 占用端口的进程若能确认工作目录属于该仓库,则附带 pid(前端可据此提供停止)。
pub fn probe_ports(repo: &str, extra: &[u16]) -> Vec<ProbedPort> {
    let mut cands = collect_ports(repo);
    for p in extra {
        // 自定义端口与推断端口重复时保留推断来源(tauri 标记优先级更高)
        if !cands.iter().any(|(x, _)| x == p) {
            cands.push((*p, "custom"));
        }
    }
    cands
        .into_iter()
        .filter(|(p, _)| probe_port(*p))
        .map(|(port, source)| ProbedPort {
            port,
            source: source.to_string(),
            pid: listening_pid_for_repo(port, repo),
        })
        .collect()
}

/// 定位监听指定端口的进程,并确认其工作目录是否属于该仓库(避免误杀无关进程)。
fn listening_pid_for_repo(port: u16, repo: &str) -> Option<i32> {
    let out = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let pid: i32 = line.trim().parse().ok()?;
        if pid_cwd_in_repo(pid, repo) {
            return Some(pid);
        }
    }
    None
}

/// 进程工作目录是否属于该仓库(或其子目录)
pub fn pid_cwd_in_repo(pid: i32, repo: &str) -> bool {
    let cwd = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok();
    let Some(cwd) = cwd else { return false };
    if !cwd.status.success() {
        return false;
    }
    let root = repo.trim_end_matches('/');
    // -Fn 输出形如 "pn...\nn<path>",取 n 开头的路径行
    String::from_utf8_lossy(&cwd.stdout).lines().any(|l| {
        l.strip_prefix('n')
            .map(|p| p == root || p.starts_with(&format!("{}/", root)))
            .unwrap_or(false)
    })
}

/// 某 PID 是否正在监听指定端口(停止前的复查,防 PID 复用/端口易主)
pub fn pid_listens_port(pid: i32, port: u16) -> bool {
    let out = std::process::Command::new("lsof")
        .args(["-nP", "-i", &format!("tcp:{}", port), "-t"])
        .output()
        .ok();
    let Some(out) = out else { return false };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.trim().parse::<i32>().ok() == Some(pid))
}

/// 停止外部进程:先取监听 PID 的真实进程组号(getpgid)再整组 SIGTERM,2 秒后仍存活再 SIGKILL。
/// 终端启动的 npm/pnpm 等链式进程,组长是 npm 自身,监听进程只是组员,
/// 直接 killpg(pid) 会因该组号不存在而静默失败(看似成功实则没停掉)。
/// 调用前必须已通过 cwd 归属校验。
pub fn kill_process_group(pid: i32) -> Result<(), String> {
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid < 0 {
        return Ok(()); // 进程已退出,无需停止
    }
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    for _ in 0..20 {
        if !process_alive(pid) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    // SIGKILL 后稍等回收,仍未死则如实报错(不再静默假成功)
    std::thread::sleep(Duration::from_millis(300));
    if process_alive(pid) {
        return Err(format!("停止失败：进程 {pid} 仍在运行"));
    }
    Ok(())
}

/// 进程是否仍存活(kill 探测)
fn process_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
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
        if let Some((_, existing)) = map.get_mut(repo) {
            if existing.try_wait().ok().flatten().is_none() {
                return Err("该项目已在运行,请先停止".into());
            }
        }
        map.insert(repo.to_string(), (command.to_string(), child));
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
        let mut g = match pending.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if *g > 0 {
            *g -= 1;
        }
        *g == 0
    };
    if !done {
        return;
    }
    let (code, cmd) = {
        let registry = app.state::<RunRegistry>();
        let mut map = registry.inner().0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cmd, mut child)) = map.remove(repo) {
            (child.try_wait().ok().flatten().and_then(|s| s.code()), cmd)
        } else {
            (None, String::new())
        }
    };
    let _ = app.emit(
        "server-status",
        serde_json::json!({ "repo": repo, "running": false, "code": code, "command": cmd }),
    );
}

/// 停止指定仓库的服务器(若存在且存活)。返回是否实际操作过。
/// 进程以独立进程组启动,这里 killpg 整个组,确保 npm/node 等实际命令一并退出。
pub fn stop(app: &AppHandle, repo: &str) -> Result<bool, String> {
    let registry = app.state::<RunRegistry>();
    let mut map = registry.inner().0.lock().map_err(|e| e.to_string())?;
    let Some((cmd, mut child)) = map.remove(repo) else {
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
        serde_json::json!({ "repo": repo, "running": false, "code": null, "command": cmd }),
    );
    Ok(true)
}

/// 该仓库是否存在存活的服务器进程;有则返回其运行命令(供 server_status 恢复前端运行态)
pub fn running_cmd(app: &AppHandle, repo: &str) -> Option<String> {
    let registry = app.state::<RunRegistry>();
    let Ok(mut map) = registry.inner().0.lock() else {
        return None;
    };
    if let Some((cmd, child)) = map.get_mut(repo) {
        if matches!(child.try_wait(), Ok(None)) {
            return Some(cmd.clone());
        }
    }
    None
}

/// 退出应用前统一清理,避免孤儿进程
pub fn kill_all(app: &AppHandle) {
    let registry = app.state::<RunRegistry>();
    let mut map = registry.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    for (_, (_, mut child)) in map.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_ports, detect, detect_all, extract_ports, kill_process_group, probe_port, process_alive};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    // 每个测试一个独立临时目录,目录名带 pid + 自增序号,避免并发/重入冲突
    fn tmpdir(name: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let p =
            std::env::temp_dir().join(format!("hg-runner-{}-{}-{}", std::process::id(), name, n));
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
        assert_eq!(
            cmds,
            ["npm run dev", "npm run preview", "npm run tauri dev"]
        );
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

    // 复现外部停止 bug 场景:组长(如 npm)与组员(如 dev server)同组,
    // 对组员 pid 调 kill_process_group 必须连带组长整组终止
    #[test]
    fn kill_process_group_kills_leader_too() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        // 组长 sh(独立进程组),内部再 fork 组员 sleep:目标 pid 是组员而非组长
        let mut leader = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 300 & wait")
            .process_group(0)
            .spawn()
            .unwrap();
        let lpid = leader.id() as i32;
        // 等 sh fork 出组员,再用 pgrep 找到它
        std::thread::sleep(Duration::from_millis(300));
        let out = std::process::Command::new("pgrep")
            .arg("-P")
            .arg(lpid.to_string())
            .output()
            .unwrap();
        let member: i32 = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .and_then(|l| l.trim().parse().ok())
            .expect("未找到组员进程");
        assert_ne!(member, lpid);

        kill_process_group(member).unwrap();
        assert!(!process_alive(member), "组员应被终止");
        // 组长是本测试的子进程,退出后成僵尸,kill(0) 仍报存活:须 try_wait 收尸后再断言
        let mut leader_gone = false;
        for _ in 0..20 {
            if leader.try_wait().ok().flatten().is_some() {
                leader_gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(leader_gone, "组长应被连带终止");
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
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"dev":"vite --port 1420","tauri":"tauri"}}"#,
        )
        .unwrap();
        fs::write(
            d.join("src-tauri/tauri.conf.json"),
            r#"{"devUrl":"http://localhost:1421"}"#,
        )
        .unwrap();
        let r = collect_ports(d.to_str().unwrap());
        let ports: Vec<u16> = r.iter().map(|x| x.0).collect();
        assert_eq!(ports, vec![1420, 1421]); // 命令端口 + devUrl 端口都解析
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn collect_ports_tauri_same_port_precedence() {
        // scripts 与 devUrl 同端口(QuiX 形态):该端口最终是桌面应用内部资源,
        // 来源必须归一为 tauri,前端才不提供浏览器打开
        let d = tmpdir("portstaurisame");
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"dev":"vite --port 1420","tauri":"tauri"}}"#,
        )
        .unwrap();
        fs::write(
            d.join("src-tauri/tauri.conf.json"),
            r#"{"devUrl":"http://localhost:1420"}"#,
        )
        .unwrap();
        let r = collect_ports(d.to_str().unwrap());
        assert_eq!(r, vec![(1420, "tauri")]); // scripts 先入,devUrl 后到应覆盖为 tauri
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
        fs::write(
            d.join("vite.config.ts"),
            "export default { server: { port: 4000 } }",
        )
        .unwrap();
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

mod ai;
mod config;
mod git;
mod process;
mod runner;
mod watcher;

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
    /// 项目分类:web(网页应用)/ desktop(桌面应用)/ extension(浏览器插件)/ backend(后端服务)/ other
    category: String,
}

/// 图标搜索目录(相对项目根,按优先级;空串为根目录)
const ICON_DIRS: &[&str] = &[
    "",
    "public",
    "assets",
    "src/assets",
    "static",
    "icons",
    "images",
    // Next.js App Router 约定位置(app/icon.svg、src/app/favicon.ico)
    "app",
    "src/app",
    "src-tauri/icons",
    "build",
    "resources",
];

/// 目录内优先精确匹配的文件名(忽略大小写)
const EXACT_ICON_NAMES: &[&str] = &[
    "logo.png",
    "logo.jpg",
    "logo.jpeg",
    "logo.svg",
    "logo.webp",
    "logo.gif",
    "icon.png",
    "icon.jpg",
    "icon.svg",
    "icon.ico",
    "app-icon.png",
    "appicon.png",
    "app.png",
    "favicon.png",
    "favicon.svg",
    "favicon.ico",
    "apple-touch-icon.png",
    "apple-icon.png",
    "icon128.png",
    "icon-128.png",
    "icon48.png",
    "icon-48.png",
    "icon16.png",
    "icon-16.png",
    // Tauri 默认图标命名
    "128x128.png",
    "32x32.png",
];

/// 支持的图标扩展名 → 读取优先级(数值越小越优先)
fn icon_ext_priority(ext: &str) -> Option<u8> {
    Some(match ext {
        "png" => 0,
        "svg" => 1,
        "webp" => 2,
        "jpg" | "jpeg" => 3,
        "gif" => 4,
        "ico" => 5,
        _ => return None,
    })
}

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

/// 在单个目录内查找图标:先按固定文件名精确匹配(忽略大小写),
/// 再按名称模式模糊匹配(logo*/icon* 前缀,-logo/_logo/-icon/_icon 后缀)
fn icon_in_dir(dir: &std::path::Path) -> Option<String> {
    let entries: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path()))
        .collect();
    for want in EXACT_ICON_NAMES {
        if let Some((_, p)) = entries.iter().find(|(n, _)| n == want) {
            if let Some(u) = read_icon_data_url(p) {
                return Some(u);
            }
        }
    }
    // (前缀优先于后缀, png 优先于 svg, 名字) 三元组取最小
    let mut best: Option<(u8, u8, &str, &std::path::PathBuf)> = None;
    for (name, p) in &entries {
        let Some((stem, ext)) = name.rsplit_once('.') else {
            continue;
        };
        let Some(ext_pri) = icon_ext_priority(ext) else {
            continue;
        };
        let name_pri = if stem.starts_with("logo") || stem.starts_with("icon") {
            0
        } else if stem.ends_with("-logo") || stem.ends_with("_logo") {
            1
        } else if stem.ends_with("-icon") || stem.ends_with("_icon") {
            2
        } else {
            continue;
        };
        let key = (name_pri, ext_pri, name.as_str(), p);
        if best.is_none() || key < best.unwrap() {
            best = Some(key);
        }
    }
    read_icon_data_url(best?.3)
}

/// 读取项目图标文件,转为 base64 data URL;
/// 找不到真实图标时返回 None(前端渲染「首字符 + 稳定配色」字母头像)
fn repo_icon_data_url(repo: &str) -> Option<String> {
    let repo_path = std::path::Path::new(repo);
    // 1. Chrome 扩展 manifest.json 声明(最精确)
    if let Some(url) = chrome_manifest_icon(repo_path) {
        return Some(url);
    }
    // 2. 常见目录:固定文件名 + 名称模式匹配
    for dir in ICON_DIRS {
        if let Some(url) = icon_in_dir(&repo_path.join(dir)) {
            return Some(url);
        }
    }
    // 3. 无真实图标:返回 None,前端兜底字母头像
    None
}

/// 识别项目分类(按特征文件/依赖判断,优先级从上到下):
/// manifest_version(manifest.json)→ 浏览器插件;tauri.conf / electron 依赖 → 桌面应用;
/// package.json 含前端框架或构建器 → Web 应用,纯 node → 后端;
/// manage.py / go.mod / docker compose / wrangler.toml → 后端服务;
/// 仅 index.html → Web;其余 → 其他
fn repo_category(repo: &str) -> &'static str {
    let root = std::path::Path::new(repo);
    if let Ok(t) = std::fs::read_to_string(root.join("manifest.json")) {
        if t.contains("manifest_version") {
            return "extension";
        }
    }
    if root.join("src-tauri/tauri.conf.json").exists() || root.join("tauri.conf.json").exists() {
        return "desktop";
    }
    // 移动端:Flutter(pubspec.yaml) / React Native / uni-app / 原生 Android
    if root.join("pubspec.yaml").exists()
        || root.join("android/app/build.gradle").exists()
        || root.join("android/app/build.gradle.kts").exists()
        || root.join("AndroidManifest.xml").exists()
    {
        return "mobile";
    }
    // package.json:electron → 桌面;移动框架 → 移动端;前端框架/构建器 → Web;纯 node → 后端
    if let Ok(t) = std::fs::read_to_string(root.join("package.json")) {
        if t.contains("\"electron\"") {
            return "desktop";
        }
        let mobile_kw = [
            "\"react-native\"",
            "\"uni-app\"",
            "\"@tarojs/",
            "\"expo\"",
            "\"flutter\"",
        ];
        if mobile_kw.iter().any(|k| t.contains(k)) {
            return "mobile";
        }
        let web_kw = [
            "\"react\"",
            "\"vue\"",
            "\"next\"",
            "\"nuxt\"",
            "\"vite\"",
            "\"svelte\"",
            "\"astro\"",
            "\"solid-js\"",
            "\"@angular/",
            "\"webpack\"",
            "\"@tauri-apps/",
            "\"tailwindcss\"",
        ];
        if web_kw.iter().any(|k| t.contains(k)) {
            return "web";
        }
        return "backend";
    }
    if root.join("manage.py").exists()
        || root.join("go.mod").exists()
        || root.join("wrangler.toml").exists()
        || root.join("docker-compose.yml").exists()
        || root.join("docker-compose.yaml").exists()
        || root.join("compose.yml").exists()
        || root.join("compose.yaml").exists()
    {
        return "backend";
    }
    // Swift 项目(Package.swift):含服务器框架 → 后端;源码用 SwiftUI/AppKit → macOS 原生应用(桌面端)
    if root.join("Package.swift").exists() {
        if let Ok(t) = std::fs::read_to_string(root.join("Package.swift")) {
            if t.contains("vapor") || t.contains("hummingbird") {
                return "backend";
            }
        }
        let src_dir = root.join("Sources");
        if let Ok(entries) = std::fs::read_dir(src_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if let Ok(rd) = std::fs::read_dir(&p) {
                        for f in rd.flatten() {
                            if let Ok(code) = std::fs::read_to_string(f.path()) {
                                if code.contains("SwiftUI") || code.contains("AppKit") {
                                    return "desktop";
                                }
                            }
                        }
                    }
                }
            }
        }
        return "other";
    }
    if root.join("index.html").exists() {
        return "web";
    }
    "other"
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
        last_commit_ts: if st.is_repo {
            git::last_commit_ts(path)
        } else {
            None
        },
        icon: icon_cached(path),
        category: repo_category(path).to_string(),
    }
}

/// 图标 data URL 缓存:图标内容基本不变,避免每次刷新都对全部项目读文件 + base64 编码
static ICON_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn icon_cached(path: &str) -> Option<String> {
    if let Ok(c) = ICON_CACHE.lock() {
        if let Some(v) = c.get(path) {
            return v.clone();
        }
    }
    let v = repo_icon_data_url(path);
    if let Ok(mut c) = ICON_CACHE.lock() {
        c.insert(path.to_string(), v.clone());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_platform_paths_for_repo_identity() {
        let normalized = normalize(r"C:\Work\Hello-Gitty\");
        if cfg!(windows) {
            assert_eq!(normalized, "c:/work/hello-gitty");
        } else {
            assert_eq!(normalized, "C:/Work/Hello-Gitty");
        }
    }

    #[test]
    fn scans_nested_repos_and_skips_deps() {
        let dir = std::env::temp_dir().join(format!("hellogitty-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 结构:root(非仓库)/ proj-a(repo) / proj-b(普通) / node_modules/pkg(repo,应跳过)
        //        / work/proj-c(repo,嵌套两层,应发现)
        std::fs::create_dir_all(dir.join("proj-a/.git")).unwrap();
        std::fs::create_dir_all(dir.join("proj-b/src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg/.git")).unwrap();
        std::fs::create_dir_all(dir.join("work/proj-c/.git")).unwrap();

        let mut found = Vec::new();
        scan_repos(&dir, 0, &mut found);
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(names.len(), 2, "应只收集 proj-a 与 proj-c,实际: {names:?}");
        assert!(
            names.iter().any(|n| n == "proj-a"),
            "proj-a 应被发现: {names:?}"
        );
        assert!(
            names.iter().any(|n| n == "proj-c"),
            "proj-c 应被发现: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n == "pkg"),
            "node_modules 内仓库应被跳过"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_common_icon() {
        let dir = std::env::temp_dir().join(format!("hellogitty-icon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 空目录 → 无真实图标(None,前端渲染字母头像)
        assert!(
            repo_icon_data_url(dir.to_str().unwrap()).is_none(),
            "空目录应无图标"
        );
        // 根目录 icon.png → data URL
        std::fs::write(dir.join("icon.png"), vec![0x89, 0x50, 0x4e, 0x47]).unwrap();
        let url = repo_icon_data_url(dir.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        std::fs::remove_file(dir.join("icon.png")).unwrap();
        // 子目录 src-tauri/icons/icon.png → 也能找到(Tauri 项目)
        std::fs::create_dir_all(dir.join("src-tauri/icons")).unwrap();
        std::fs::write(
            dir.join("src-tauri/icons/icon.png"),
            vec![0x89, 0x50, 0x4e, 0x47],
        )
        .unwrap();
        let url = repo_icon_data_url(dir.to_str().unwrap()).unwrap();
        assert!(
            url.starts_with("data:image/png;base64,"),
            "子目录图标应被发现"
        );
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
        assert!(
            url.starts_with("data:image/png;base64,"),
            "manifest icons 应被解析"
        );
        // 路径含 .. 应被拒绝,无图标
        std::fs::remove_file(dir.join("icons/icon128.png")).unwrap(); // 清掉候选路径命中,确保返回 None
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"manifest_version":3,"icons":{"128":"../../etc/passwd"}}"#,
        )
        .unwrap();
        assert!(
            repo_icon_data_url(dir.to_str().unwrap()).is_none(),
            "穿越路径应被拒绝"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn categorizes_projects() {
        let base = std::env::temp_dir().join(format!("hellogitty-cat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mk = |name: &str| {
            let d = base.join(name);
            std::fs::create_dir_all(&d).unwrap();
            d
        };
        // Web:package.json 含 react 依赖
        let web = mk("web");
        std::fs::write(
            web.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"^18"}}"#,
        )
        .unwrap();
        // 桌面:src-tauri/tauri.conf.json
        let desktop = mk("desktop");
        std::fs::create_dir_all(desktop.join("src-tauri")).unwrap();
        std::fs::write(desktop.join("src-tauri/tauri.conf.json"), "{}").unwrap();
        // 浏览器插件:manifest.json 带 manifest_version
        let ext = mk("ext");
        std::fs::write(ext.join("manifest.json"), r#"{"manifest_version":3}"#).unwrap();
        // 后端:manage.py(Django)
        let backend = mk("backend");
        std::fs::write(backend.join("manage.py"), "").unwrap();
        // 纯 node(无前端框架)→ 后端
        let node = mk("node");
        std::fs::write(
            node.join("package.json"),
            r#"{"scripts":{"start":"node server.js"},"dependencies":{"express":"^4"}}"#,
        )
        .unwrap();
        // 静态站:仅 index.html → Web
        let statics = mk("static");
        std::fs::write(statics.join("index.html"), "<html></html>").unwrap();
        // 空 → 其他
        let other = mk("other");
        // Swift:SwiftUI/AppKit 源码 → macOS 桌面端应用
        let swift_app = mk("swiftapp");
        std::fs::write(swift_app.join("Package.swift"), "// swift-tools-version: 6.0").unwrap();
        std::fs::create_dir_all(swift_app.join("Sources/App")).unwrap();
        std::fs::write(
            swift_app.join("Sources/App/main.swift"),
            "import SwiftUI\n@main struct App: App {}",
        )
        .unwrap();
        // Swift:Vapor → 后端
        let swift_api = mk("swiftapi");
        std::fs::write(
            swift_api.join("Package.swift"),
            "import PackageDescription\nlet p = Package(dependencies: [.package(url: \"vapor/vapor\")])",
        )
        .unwrap();
        std::fs::create_dir_all(swift_api.join("Sources/Api")).unwrap();
        std::fs::write(swift_api.join("Sources/Api/main.swift"), "import Vapor").unwrap();
        // Swift:纯库(无 UI 无服务器框架)→ 其他
        let swift_lib = mk("swiftlib");
        std::fs::write(swift_lib.join("Package.swift"), "// swift-tools-version: 6.0").unwrap();
        std::fs::create_dir_all(swift_lib.join("Sources/Lib")).unwrap();
        std::fs::write(swift_lib.join("Sources/Lib/lib.swift"), "public struct Lib {}").unwrap();
        // Flutter → 移动端
        let flutter = mk("flutter");
        std::fs::write(flutter.join("pubspec.yaml"), "name: app\n").unwrap();
        // React Native → 移动端
        let rn = mk("rn");
        std::fs::write(
            rn.join("package.json"),
            r#"{"dependencies":{"react-native":"^0.72"}}"#,
        )
        .unwrap();
        // 原生 Android → 移动端
        let android = mk("android");
        std::fs::create_dir_all(android.join("android/app")).unwrap();
        std::fs::write(android.join("android/app/build.gradle"), "android {}").unwrap();
        for (dir, want) in [
            (&web, "web"),
            (&desktop, "desktop"),
            (&ext, "extension"),
            (&backend, "backend"),
            (&node, "backend"),
            (&statics, "web"),
            (&other, "other"),
            (&swift_app, "desktop"),
            (&swift_api, "backend"),
            (&swift_lib, "other"),
            (&flutter, "mobile"),
            (&rn, "mobile"),
            (&android, "mobile"),
        ] {
            assert_eq!(
                repo_category(dir.to_str().unwrap()),
                want,
                "{} 分类错误",
                dir.display()
            );
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn finds_icon_by_pattern_and_case() {
        let dir = std::env::temp_dir().join(format!("hellogitty-icon2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let png = vec![0x89, 0x50, 0x4e, 0x47];
        // public/favicon.svg(Vite 项目常见)→ 精确命中
        std::fs::create_dir_all(dir.join("public")).unwrap();
        std::fs::write(dir.join("public/favicon.svg"), "<svg/>").unwrap();
        assert!(repo_icon_data_url(dir.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        std::fs::remove_file(dir.join("public/favicon.svg")).unwrap();
        // icons/icon-128.png(带连字符命名,忽略大小写)→ 精确命中
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        std::fs::write(dir.join("icons/Icon-128.png"), &png).unwrap();
        assert!(
            repo_icon_data_url(dir.to_str().unwrap()).is_some(),
            "连字符命名应命中"
        );
        std::fs::remove_dir_all(dir.join("icons")).unwrap();
        // 模式匹配:Nextgen-Logo.svg 优先于 free-shipping-icon.svg(-logo 后缀优于 -icon)
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/free-shipping-icon.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("assets/Nextgen-Logo.svg"), "<svg/>").unwrap();
        // -logo 后缀应优先于 -icon 后缀
        assert_eq!(
            icon_in_dir(&dir.join("assets")),
            read_icon_data_url(&dir.join("assets/Nextgen-Logo.svg"))
        );
        // 框架占位图(vite.svg/vercel.svg)不应被选中
        std::fs::remove_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("public/vite.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("public/vercel.svg"), "<svg/>").unwrap();
        assert!(
            repo_icon_data_url(dir.to_str().unwrap()).is_none(),
            "占位图不应被选中"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// 读取配置中的仓库列表并逐个生成状态摘要。
/// 异步 + spawn_blocking + 项目间并行:每个项目要跑 2 个 git 子进程,
/// 串行同步执行会长时间阻塞主线程(进入总览时明显卡顿)。
#[tauri::command]
async fn repos_status_all(app: tauri::AppHandle) -> Vec<RepoSummary> {
    let settings = SettingsStore::new(&app).load();
    let paths = settings.repos.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|s| {
            let handles: Vec<_> = paths
                .iter()
                .enumerate()
                .map(|(i, p)| (i, p, s.spawn(|| summarize(p))))
                .collect();
            let mut out: Vec<(usize, RepoSummary)> = Vec::with_capacity(handles.len());
            for (i, p, h) in handles {
                // 并行线程 panic 时兜底串行重试,保证结果与列表顺序一致
                let sum = h.join().unwrap_or_else(|_| summarize(p));
                out.push((i, sum));
            }
            out.sort_by_key(|(i, _)| *i);
            out.into_iter().map(|(_, sum)| sum).collect()
        })
    })
    .await
    .unwrap_or_default()
}

/// 已添加项目的近一年提交活动。每个项目只统计当前 HEAD，按日期合并后交给总览热力图。
#[derive(Serialize, Default)]
struct ActivitySummary {
    days: Vec<git::CommitDay>,
    total: usize,
}

#[tauri::command]
async fn repos_activity(repos: Vec<String>, since: i64) -> ActivitySummary {
    tauri::async_runtime::spawn_blocking(move || {
        let mut counts = std::collections::BTreeMap::<String, usize>::new();
        for path in repos {
            for day in git::commit_days(&path, since) {
                *counts.entry(day.date).or_default() += day.count;
            }
        }
        let total = counts.values().sum();
        let days = counts
            .into_iter()
            .map(|(date, count)| git::CommitDay { date, count })
            .collect();
        ActivitySummary { days, total }
    })
    .await
    .unwrap_or_default()
}

/// 已添加项目的近 N 日代码量(新增/删除行数),按日期合并后交给总览柱状图。
/// 同日多仓库累加;无活动的日期不出现在结果中,由前端补零
#[derive(Serialize, Default)]
struct CodeVolumeSummary {
    days: Vec<git::CodeDay>,
}

#[tauri::command]
async fn repos_code_volume(repos: Vec<String>, since: i64) -> CodeVolumeSummary {
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = std::collections::BTreeMap::<String, (usize, usize)>::new();
        for path in repos {
            for day in git::code_days(&path, since) {
                let e = map.entry(day.date).or_default();
                e.0 += day.add;
                e.1 += day.del;
            }
        }
        CodeVolumeSummary {
            days: map
                .into_iter()
                .map(|(date, (add, del))| git::CodeDay { date, add, del })
                .collect(),
        }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn repos_add(app: tauri::AppHandle, path: String) -> Result<RepoAddResult, String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    let key = normalize(&path);
    let existing = s.repos.iter().find(|p| normalize(p) == key).cloned();
    let (stored_path, added) = if let Some(existing) = existing {
        (existing, false)
    } else {
        s.repos.push(path.clone());
        store.save(&s)?;
        (path, true)
    };
    Ok(RepoAddResult {
        repos: s.repos,
        path: stored_path,
        added,
    })
}

#[derive(Serialize)]
struct RepoAddResult {
    repos: Vec<String>,
    path: String,
    added: bool,
}

/// 目录扫描时跳过的子目录(依赖缓存/构建产物,体积大且不可能含独立仓库;隐藏目录另行整体跳过)
const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
];

/// 递归扫描目录下的所有 Git 仓库(含所选目录本身),去重后加入项目列表。
/// 深度上限 4 层;命中仓库后不再深入(嵌套子仓库不重复收集)。
/// 返回 (本次新增路径, 全部项目路径)。
#[tauri::command]
async fn repos_scan_dir(
    app: tauri::AppHandle,
    dir: String,
) -> Result<(Vec<String>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&dir)
            .canonicalize()
            .map_err(|e| format!("目录不可访问： {e}"))?;
        let mut found = Vec::new();
        scan_repos(&root, 0, &mut found);

        let store = SettingsStore::new(&app);
        let mut s = store.load();
        let mut known: std::collections::HashSet<String> =
            s.repos.iter().map(|p| normalize(p)).collect();
        let mut added = Vec::new();
        for p in found {
            let key = normalize(&p);
            if !known.contains(&key) {
                known.insert(key);
                s.repos.push(p.clone());
                added.push(p);
            }
        }
        if !added.is_empty() {
            store.save(&s)?;
        }
        Ok((added, s.repos))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_repos(dir: &std::path::Path, depth: usize, found: &mut Vec<String>) {
    if depth > 4 {
        return;
    }
    // .git 可为目录(常规仓库)或文件(worktree/submodule)
    if dir.join(".git").exists() {
        found.push(dir.to_string_lossy().to_string());
        return; // 仓库内部不再深入,避免收集其子模块/嵌套仓库
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // 隐藏目录一律不深入(.git 由递归入口处的仓库判定处理)
        if name.starts_with('.') {
            continue;
        }
        if SCAN_SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
            continue;
        }
        scan_repos(&e.path(), depth + 1, found);
    }
}

/// 路径归一化:去掉尾部分隔符,统一用于重复判断(不做 canonicalize,避免未存在的路径报错)
fn normalize(p: &str) -> String {
    let normalized = p.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[tauri::command]
fn repos_remove(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    let key = normalize(&path);
    s.repos.retain(|p| normalize(p) != key);
    if s.last_repo.as_deref().map(normalize).as_deref() == Some(key.as_str()) {
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

/// 清空全部项目(关闭所有项目)
#[tauri::command]
fn repos_clear(app: tauri::AppHandle) -> Result<(), String> {
    let store = SettingsStore::new(&app);
    let mut s = store.load();
    s.repos.clear();
    s.last_repo = None;
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
        let out = process::command("git")
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
            git::run_git(
                &repo,
                &[
                    "diff",
                    "--cached",
                    "--no-color",
                    "--no-ext-diff",
                    "--",
                    &path,
                ],
            )
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

/// 多选项目文件夹;只返回用户直接选中的目录,不递归扫描其子目录。
#[tauri::command]
async fn pick_folders(app: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("选择项目文件夹")
        .blocking_pick_folders();
    match picked {
        Some(paths) => {
            let mut result = Vec::with_capacity(paths.len());
            for path in paths {
                result.push(
                    path.into_path()
                        .map_err(|e| format!("读取所选路径失败： {e}"))?
                        .to_string_lossy()
                        .to_string(),
                );
            }
            Ok(Some(result))
        }
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
            (
                commits,
                Some(RemoteHistory {
                    name,
                    commits: remote_commits,
                }),
            )
        }
        None => (git::log(&repo, 20), None),
    };
    History {
        head,
        commits,
        remote,
    }
}

#[derive(Serialize)]
struct RefreshResult {
    status: git::RepoStatus,
    history: History,
}

/// 合并 status + history 的单次刷新命令:1 次 status 即拿到 branch/upstream/ahead/behind/head,
/// 再据此只跑必要的 log,省掉 git_history 里重复的 head_hash/upstream/ahead/behind 进程。
/// 切换仓库的 git 进程数从最多 7 次降到 3 次(无上游 2-3 次),显著降低 Windows 切换延迟。
#[tauri::command]
async fn git_refresh(repo: String) -> RefreshResult {
    use tauri::async_runtime::spawn_blocking;
    let r0 = repo.clone();
    let st = spawn_blocking(move || git::status(&r0))
        .await
        .unwrap_or_default();

    if !st.is_repo {
        return RefreshResult {
            status: st,
            history: History::default(),
        };
    }

    let head = st.head.clone();
    // upstream 取自 status(已解析);未设置上游时才兜底查第一个远程跟踪分支
    let remote_name = st
        .upstream
        .clone()
        .or_else(|| git::first_remote_branch(&repo));
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
            (
                commits,
                Some(RemoteHistory {
                    name,
                    commits: remote_commits,
                }),
            )
        }
        None => {
            let r3 = repo.clone();
            (
                spawn_blocking(move || git::log(&r3, 20))
                    .await
                    .unwrap_or_default(),
                None,
            )
        }
    };

    RefreshResult {
        status: st,
        history: History {
            head,
            commits,
            remote,
        },
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

/// 把所有命中忽略规则的已跟踪文件移出 git 跟踪(保留工作区文件),使其在
/// 添加 .gitignore 规则后立即从状态列表消失(目录/通配规则覆盖的全部文件)。
#[tauri::command]
fn git_untrack_ignored(repo: String) -> Result<(), String> {
    git::untrack_ignored(&repo)
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
    op(
        tauri::async_runtime::spawn_blocking(move || git::commit(&repo, &message))
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
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

#[cfg(target_os = "macos")]
fn open_external_http(url: &str) -> Result<(), String> {
    let output = std::process::Command::new("open").arg(url).output();
    let output = output.map_err(|e| format!("无法打开浏览器： {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "无法打开系统浏览器".into()
        } else {
            format!("无法打开浏览器： {detail}")
        })
    }
}

#[cfg(target_os = "windows")]
fn open_external_http(url: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result > 32 {
        Ok(())
    } else {
        Err(format!("无法打开系统浏览器（Windows 错误码 {result}）"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_external_http(_url: &str) -> Result<(), String> {
    Err("仅支持 macOS 和 Windows".into())
}

/// 在系统浏览器打开 GitHub 生成 Token 的页面(预填 repo scope)
#[tauri::command]
async fn open_auth_page() -> Result<(), String> {
    let url = "https://github.com/settings/tokens/new?scopes=repo&description=Hello+Gitty";
    open_external_http(url)
}

/// 把 Token 写入系统钥匙串(git credential approve)
fn credential_approve(token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = process::command("git")
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
        .write_all(
            format!("protocol=https\nhost=github.com\nusername=git\npassword={token}\n\n")
                .as_bytes(),
        )
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
        "repo",
        "create",
        &name,
        "--private",
        "--source",
        repo,
        "--remote",
        "origin",
        "--push",
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
    let mut candidates = vec![std::path::PathBuf::from("gh")];
    #[cfg(target_os = "macos")]
    candidates.extend([
        std::path::PathBuf::from("/opt/homebrew/bin/gh"),
        std::path::PathBuf::from("/usr/local/bin/gh"),
    ]);
    #[cfg(target_os = "windows")]
    {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(std::path::PathBuf::from(program_files).join("GitHub CLI/gh.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                std::path::PathBuf::from(local_app_data).join("Programs/GitHub CLI/gh.exe"),
            );
        }
    }
    for gh in candidates {
        let out = process::command(&gh).args(args).output().ok();
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
    let mut child = process::command("git")
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
    op(
        tauri::async_runtime::spawn_blocking(move || git::pull(&repo))
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
}

/// 后台静默 fetch:更新远程跟踪分支;失败(无远程/无网络/未认证)返回 ok:false,
/// 由前端静默忽略,不打扰用户。
#[tauri::command]
async fn git_fetch(repo: String) -> OpResult {
    op(
        tauri::async_runtime::spawn_blocking(move || git::fetch(&repo))
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
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

/// 流式生成提交信息:每收到一段就经 commit-stream 事件推送当前累积全文,返回最终全文。
/// 事件携带 repo,前端可区分是哪个项目的流(多项目面板独立时必要)
#[tauri::command]
async fn ai_commit_message_stream(
    app: tauri::AppHandle,
    settings: AiConfig,
    repo: String,
) -> Result<String, String> {
    let handle = app.clone();
    let repo_tag = repo.clone();
    ai::generate_commit_message_stream(&settings, &repo, move |text| {
        let _ = handle.emit(
            "commit-stream",
            serde_json::json!({ "text": text, "repo": repo_tag }),
        );
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

/// 查询仓库的服务器是否在运行,并返回运行中的命令(供前端恢复对应命令的运行态)
#[tauri::command]
fn server_status(app: tauri::AppHandle, repo: String) -> runner::ServerStatus {
    match runner::running_cmd(&app, &repo) {
        Some(command) => runner::ServerStatus {
            running: true,
            command: Some(command),
        },
        None => runner::ServerStatus {
            running: false,
            command: None,
        },
    }
}

/// 检测仓库是否已在外部运行:探测其开发端口(+ 自定义地址端口),返回被占用的端口列表(空 = 未检测到)
#[tauri::command]
async fn server_external_check(repo: String, extra: Option<Vec<u16>>) -> Vec<runner::ProbedPort> {
    let r = repo.clone();
    let e = extra.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || runner::probe_ports(&r, &e))
        .await
        .unwrap_or_default()
}

/// 总览页:批量检测多个仓库的外部运行端口,并行探测,返回 路径 → 占用端口列表。
/// extra:路径 → 自定义运行地址解析出的端口,一并探测
#[tauri::command]
async fn server_external_check_all(
    repos: Vec<String>,
    extra: Option<std::collections::HashMap<String, Vec<u16>>>,
) -> std::collections::HashMap<String, Vec<runner::ProbedPort>> {
    let extra = extra.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|s| {
            let handles: Vec<_> = repos
                .iter()
                .map(|r| {
                    let e: &[u16] = extra.get(r).map(|v| v.as_slice()).unwrap_or(&[]);
                    s.spawn(move || (r.clone(), runner::probe_ports(r, e)))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        })
    })
    .await
    .unwrap_or_default()
}

/// 单个开发端口信息(来源:explicit/web/tauri/default,tauri 为 WebView 内部资源不可在浏览器打开)
#[derive(Serialize, Clone)]
struct PortInfo {
    port: u16,
    source: String,
}

/// 总览页:批量读取多仓库的静态开发端口(从项目文件推断,未运行也可得)
#[tauri::command]
async fn server_ports_all(repos: Vec<String>) -> std::collections::HashMap<String, Vec<PortInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|s| {
            let handles: Vec<_> = repos
                .iter()
                .map(|r| {
                    s.spawn(|| {
                        (
                            r.clone(),
                            runner::collect_ports(r)
                                .into_iter()
                                .map(|(port, source)| PortInfo {
                                    port,
                                    source: source.to_string(),
                                })
                                .collect::<Vec<_>>(),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        })
    })
    .await
    .unwrap_or_default()
}

/// 当前项目的静态开发端口(项目未运行时也可读取)
#[tauri::command]
async fn server_ports(repo: String) -> Vec<PortInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        runner::collect_ports(&repo)
            .into_iter()
            .map(|(port, source)| PortInfo {
                port,
                source: source.to_string(),
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 停止外部运行的进程:先确认占用端口的进程工作目录属于该仓库(防误杀),
/// 再停止监听 PID 所属的整个进程树。pid 必须来自 server_external_check 的返回。
#[tauri::command]
async fn server_external_stop(repo: String, port: u16, pid: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 复查:该 PID 当前仍监听此端口,且工作目录仍属于该仓库
        if !runner::pid_listens_port(pid, port) {
            return Err("进程已退出或端口已被其他进程占用，无需停止".into());
        }
        if !runner::pid_cwd_in_repo(pid, &repo) {
            return Err("进程工作目录不属于该项目，已拒绝停止（避免误杀）".into());
        }
        runner::kill_process_group(pid)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 打开外部 URL(默认浏览器);仅允许 http/https,避免任意协议注入
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 链接".into());
    }
    open_external_http(&url)
}

/// 在系统文件管理器中打开本地目录(右键菜单「打开本地目录」)
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_local_dir(path: String) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg(&path)
        .output()
        .map_err(|e| format!("无法打开目录： {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "无法打开系统文件管理器".into()
        } else {
            format!("无法打开目录： {detail}")
        })
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_local_dir(path: String) -> Result<(), String> {
    let output = std::process::Command::new("explorer")
        .arg(&path)
        .output()
        .map_err(|e| format!("无法打开目录： {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("无法打开系统文件管理器".into())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn open_local_dir(_path: String) -> Result<(), String> {
    Err("仅支持 macOS 和 Windows".into())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(runner::RunRegistry::default())
        .manage(watcher::RepoWatcherState::default())
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
            pick_folders,
            window_set_always_on_top,
            repos_status_all,
            repos_activity,
            repos_code_volume,
            repos_add,
            repos_scan_dir,
            repos_remove,
            repos_clear,
            repos_set_current,
            git_stage_all,
            git_unstage_all,
            git_stage_file,
            git_unstage_file,
            git_untrack_ignored,
            git_discard_all,
            git_discard_file,
            git_commit,
            git_push,
            git_push_with_token,
            open_auth_page,
            open_url,
            open_local_dir,
            git_pull,
            git_fetch,
            git_finish_merge,
            git_history,
            git_refresh,
            watcher::repo_watch_start,
            git_reset_hard,
            git_branches,
            git_checkout,
            ai_commit_message,
            ai_commit_message_stream,
            ai_presets,
            ai_resolve_file,
            ai_resolve_conflicts,
            server_detect,
            server_ports_all,
            server_ports,
            server_start,
            server_stop,
            server_status,
            server_external_check,
            server_external_check_all,
            server_external_stop,
        ])
        .on_window_event(|window, event| {
            // 关闭窗口不退出应用,隐藏到系统托盘常驻
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
            let tray_icon = if cfg!(target_os = "macos") {
                tauri::image::Image::from_bytes(include_bytes!("../icons/menu-bar-icon.png"))
                    .expect("菜单栏图标无效")
            } else {
                app.default_window_icon().expect("缺少应用图标").clone()
            };

            let _tray = TrayIconBuilder::with_id("hello-gitty-tray")
                .icon(tray_icon)
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
    // 应用真正退出时(含托盘退出与系统退出操作):统一关闭所有运行中的服务器,避免孤儿进程
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            runner::kill_all(app);
        }
    });
}

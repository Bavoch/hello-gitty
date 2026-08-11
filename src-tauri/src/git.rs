use serde::Serialize;
use std::process::Command;

pub const MAX_AI_DIFF_BYTES: usize = 60_000;

#[derive(Serialize, Clone, Default)]
pub struct FileEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub x: String, // index 状态字母
    pub y: String, // worktree 状态字母
    pub staged: bool,
    pub untracked: bool,
    pub conflict: bool,
}

impl FileEntry {}

#[derive(Serialize, Clone, Default)]
pub struct RepoStatus {
    pub repo: String,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub unborn: bool,
    pub detached: bool,
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    pub untracked: Vec<FileEntry>,
    pub conflicts: Vec<FileEntry>,
}

pub fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if stderr.trim().is_empty() { stdout } else { stderr }.trim().to_string());
    }
    Ok(stdout)
}

fn git_stdin(repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .map_err(|e| format!("写入失败: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("等待 git 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if stderr.trim().is_empty() { stdout } else { stderr }.trim().to_string());
    }
    Ok(stdout)
}

/// 解析 porcelain v2 输出,支持 C 风格引号路径(含八进制转义)。
/// 八进制转义是 UTF-8 的原始字节(如 带 = \345\270\246),须先按字节收集再整体解码。
fn unquote(s: &str) -> String {
    if !s.starts_with('"') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 1;
    // 处理到倒数第二个字节,最后一个字节是闭合引号
    while i < bytes.len() - 1 {
        let b = bytes[i];
        if b == b'\\' {
            let n = bytes[i + 1];
            match n {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b't' => out.push(b'\t'),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b'0'..=b'7' => {
                    let mut val: u32 = 0;
                    let mut k = i + 1;
                    for _ in 0..3 {
                        if k < bytes.len() - 1 && (b'0'..=b'7').contains(&bytes[k]) {
                            val = val * 8 + (bytes[k] - b'0') as u32;
                            k += 1;
                        }
                    }
                    out.push(val as u8);
                    i = k;
                    continue;
                }
                _ => {
                    out.push(b);
                    out.push(n);
                }
            }
            i += 2;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn status(repo: &str) -> RepoStatus {
    let mut st = RepoStatus {
        repo: repo.to_string(),
        ..Default::default()
    };
    let out = match run_git(repo, &["status", "--porcelain=v2", "--branch"]) {
        Ok(o) => o,
        Err(_) => return st, // 不是 git 仓库
    };
    st.is_repo = true;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            st.unborn = rest == "(initial)";
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            st.branch = if rest == "(detached)" { None } else { Some(rest.to_string()) };
            st.detached = rest == "(detached)";
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            st.upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                st.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                st.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix("? ") {
            st.untracked.push(FileEntry {
                path: unquote(rest),
                x: "?".into(),
                y: "?".into(),
                untracked: true,
                ..Default::default()
            });
            continue;
        }

        if let Some(rest) = line.strip_prefix("u ") {
            // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let mut parts = rest.splitn(10, ' ');
            let _ = parts.next(); // xy
            for _ in 0..8 {
                let _ = parts.next(); // sub, m1..m3, mW, h1..h3
            }
            let path = unquote(parts.next().unwrap_or(""));
            st.conflicts.push(FileEntry {
                path,
                x: "U".into(),
                y: "U".into(),
                conflict: true,
                ..Default::default()
            });
            continue;
        }

        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // porcelain v2 中 '.' 表示未修改(而非空格)
        if let Some(rest) = line.strip_prefix("1 ") {
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("  ").to_string();
            let path = unquote(parts.nth(6).unwrap_or(""));
            let x = xy.chars().next().unwrap_or('.').to_string();
            let y = xy.chars().nth(1).unwrap_or('.').to_string();
            let e = FileEntry { path, x: x.clone(), y: y.clone(), ..Default::default() };
            if x != "." && x != "?" {
                st.staged.push(FileEntry { staged: true, ..e.clone() });
            }
            if y != "." {
                st.unstaged.push(e);
            }
            continue;
        }

        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><sep><origPath>
        if let Some(rest) = line.strip_prefix("2 ") {
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("  ").to_string();
            let path_and_orig = parts.nth(7).unwrap_or("").to_string();
            let (path, orig) = match path_and_orig.split_once('\t') {
                Some((p, o)) => (unquote(p), Some(unquote(o))),
                None => (unquote(&path_and_orig), None),
            };
            let x = xy.chars().next().unwrap_or('.').to_string();
            let y = xy.chars().nth(1).unwrap_or('.').to_string();
            let e = FileEntry { path, orig_path: orig, x: x.clone(), y: y.clone(), ..Default::default() };
            if x != "." && x != "?" {
                st.staged.push(FileEntry { staged: true, ..e.clone() });
            }
            if y != "." {
                st.unstaged.push(e);
            }
            continue;
        }
    }
    st
}

pub fn stage_all(repo: &str) -> Result<(), String> {
    run_git(repo, &["add", "-A"]).map(|_| ())
}

pub fn unstage_all(repo: &str) -> Result<(), String> {
    let st = status(repo);
    if st.staged.is_empty() {
        return Ok(());
    }
    if st.unborn {
        // unborn 分支没有 HEAD,git reset 不可用;退化为从索引移除
        run_git(repo, &["rm", "-r", "--cached", "--quiet", "--", "."]).map(|_| ())
    } else {
        run_git(repo, &["reset", "--quiet"]).map(|_| ())
    }
}

pub fn stage_file(repo: &str, path: &str) -> Result<(), String> {
    run_git(repo, &["add", "--", path]).map(|_| ())
}

pub fn unstage_file(repo: &str, path: &str) -> Result<(), String> {
    let st = status(repo);
    if st.unborn {
        run_git(repo, &["rm", "--cached", "--quiet", "--", path]).map(|_| ())
    } else {
        run_git(repo, &["reset", "--quiet", "HEAD", "--", path]).map(|_| ())
    }
}

pub fn commit(repo: &str, message: &str) -> Result<String, String> {
    git_stdin(repo, &["commit", "-F", "-"], message)
}

pub fn push(repo: &str) -> Result<String, String> {
    let st = status(repo);
    if st.upstream.is_some() {
        run_git(repo, &["push"])
    } else if let Some(branch) = st.branch {
        run_git(repo, &["push", "-u", "origin", &branch])
    } else {
        Err("无法确定推送目标(仓库处于分离 HEAD 或没有分支)".into())
    }
}

pub fn pull(repo: &str) -> Result<String, String> {
    run_git(repo, &["pull"])
}

/// 供 AI 生成提交信息用的差异文本。
/// staged_only = true 时只采集已暂存差异(提交语义:只提交已暂存内容,信息须与实际提交一致);
/// false 时采集暂存 + 未暂存 + 未跟踪文件清单。
pub fn diff_for_ai(repo: &str, staged_only: bool) -> Result<String, String> {
    let st = status(repo);
    let mut buf = String::new();
    if let Ok(s) = run_git(repo, &["diff", "--cached", "--no-color", "--no-ext-diff", "--stat"]) {
        if !s.trim().is_empty() {
            buf.push_str("## 已暂存变更(stat)\n");
            buf.push_str(&s);
            buf.push('\n');
        }
    }
    if let Ok(s) = run_git(repo, &["diff", "--cached", "--no-color", "--no-ext-diff"]) {
        if !s.trim().is_empty() {
            buf.push_str("## 已暂存完整差异\n");
            buf.push_str(&s);
            buf.push('\n');
        }
    }
    if !staged_only {
        if let Ok(s) = run_git(repo, &["diff", "--no-color", "--no-ext-diff", "--stat"]) {
            if !s.trim().is_empty() {
                buf.push_str("## 未暂存变更(stat)\n");
                buf.push_str(&s);
                buf.push('\n');
            }
        }
        if let Ok(s) = run_git(repo, &["diff", "--no-color", "--no-ext-diff"]) {
            if !s.trim().is_empty() {
                buf.push_str("## 未暂存完整差异\n");
                buf.push_str(&s);
                buf.push('\n');
            }
        }
        if !st.untracked.is_empty() {
            buf.push_str("## 未跟踪的新文件(尚未有差异)\n");
            for f in &st.untracked {
                buf.push_str(&format!("- {}\n", f.path));
            }
        }
    }
    if buf.trim().is_empty() {
        return Err(if staged_only {
            "没有已暂存的更改".into()
        } else {
            "没有可提交的变更".into()
        });
    }
    // 超出上限时保留 stat 与尾部内容
    if buf.len() > MAX_AI_DIFF_BYTES {
        let keep = buf.len() - (buf.len() - MAX_AI_DIFF_BYTES);
        buf = buf[..keep].to_string();
        buf.push_str("\n...(差异过大已截断)\n");
    }
    Ok(buf)
}

/// 最近提交信息(供 AI 参考仓库既有风格)
pub fn recent_log(repo: &str, n: usize) -> Vec<String> {
    run_git(repo, &["log", &format!("-{n}"), "--format=%s"])
        .map(|o| o.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

/// 历史列表(按时间倒序)
pub fn log(repo: &str, n: usize) -> Vec<CommitInfo> {
    run_git(repo, &["log", &format!("-{n}"), "--format=%H%x09%h%x09%an%x09%at%x09%s"])
        .map(|o| {
            o.lines()
                .filter_map(|l| {
                    let mut p = l.splitn(5, '\t');
                    Some(CommitInfo {
                        hash: p.next()?.to_string(),
                        short: p.next()?.to_string(),
                        author: p.next()?.to_string(),
                        timestamp: p.next()?.parse().unwrap_or(0),
                        subject: p.next()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn head_hash(repo: &str) -> Option<String> {
    run_git(repo, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
}

/// 强制回退到指定提交(丢弃之后的所有提交与未提交修改)
pub fn reset_hard(repo: &str, hash: &str) -> Result<String, String> {
    run_git(repo, &["reset", "--hard", hash])
}

/// 冲突文件清单
pub fn conflict_files(repo: &str) -> Vec<String> {
    run_git(repo, &["diff", "--name-only", "--diff-filter=U"])
        .map(|o| o.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default()
}

/// 检测是否处于合并中(MERGE_HEAD 存在),若是则用 git 准备的 MERGE_MSG 完成合并提交。
/// 返回 (是否完成了合并, 提交输出);非合并状态返回 (false, "")。
pub fn finish_merge(repo: &str) -> Result<(bool, String), String> {
    let gd = run_git(repo, &["rev-parse", "--git-dir"])?;
    let gd_path = std::path::Path::new(gd.trim());
    let git_dir = if gd_path.is_absolute() {
        gd_path.to_path_buf()
    } else {
        std::path::Path::new(repo).join(gd_path)
    };
    if !git_dir.join("MERGE_HEAD").exists() {
        return Ok((false, String::new()));
    }
    let msg = std::fs::read_to_string(git_dir.join("MERGE_MSG")).unwrap_or_default();
    let msg = if msg.trim().is_empty() { "Merge".into() } else { msg.trim().to_string() };
    let out = commit(repo, &msg)?;
    Ok((true, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hellogitty-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run_git(dir.to_str().unwrap(), &["init", "-q"]).unwrap();
        run_git(
            dir.to_str().unwrap(),
            &["config", "user.email", "test@example.com"],
        )
        .unwrap();
        run_git(dir.to_str().unwrap(), &["config", "user.name", "test"]).unwrap();
        dir
    }

    #[test]
    fn parses_status_full_lifecycle() {
        let repo = temp_repo("lifecycle");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        std::fs::write(repo.join("b.txt"), "world").unwrap();

        // 未跟踪
        let st = status(r);
        assert!(st.is_repo && st.unborn);
        assert_eq!(st.untracked.len(), 2);

        // 全部暂存
        stage_all(r).unwrap();
        let st = status(r);
        assert_eq!(st.staged.len(), 2);
        assert!(st.staged.iter().all(|f| f.untracked == false));

        // 首次提交
        commit(r, "init: add files").unwrap();
        let st = status(r);
        assert!(!st.unborn);
        assert!(st.staged.is_empty() && st.untracked.is_empty());

        // 修改 + 部分暂存
        std::fs::write(repo.join("a.txt"), "hello2").unwrap();
        std::fs::write(repo.join("b.txt"), "world2").unwrap();
        stage_file(r, "a.txt").unwrap();
        let st = status(r);
        assert_eq!(st.staged.len(), 1);
        assert_eq!(st.unstaged.len(), 1);
        assert_eq!(st.staged[0].path, "a.txt");

        // 单文件取消暂存
        unstage_file(r, "a.txt").unwrap();
        let st = status(r);
        assert!(st.staged.is_empty());
        assert_eq!(st.unstaged.len(), 2);

        // 全部取消暂存(空操作不报错)
        unstage_all(r).unwrap();

        // 带空格与中文路径
        std::fs::write(repo.join("带 空格 文件.txt"), "x").unwrap();
        stage_all(r).unwrap();
        let st = status(r);
        assert!(st.staged.iter().any(|f| f.path == "带 空格 文件.txt"));

        // diff_for_ai 可用
        let d = diff_for_ai(r, false).unwrap();
        assert!(!d.is_empty());
        // staged-only:取消暂存 b.txt 后,暂存 diff 应含 a.txt 而不含 b.txt
        unstage_file(r, "b.txt").unwrap();
        let d_staged = diff_for_ai(r, true).unwrap();
        assert!(d_staged.contains("a.txt"));
        assert!(!d_staged.contains("b.txt"));

        std::fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn detects_conflicts() {
        let base = temp_repo("conflict");
        let r = base.to_str().unwrap();
        std::fs::write(base.join("f.txt"), "line1\nline2\n").unwrap();
        stage_all(r).unwrap();
        commit(r, "base").unwrap();
        // 双方在相同位置修改同一行,制造真实冲突
        run_git(r, &["checkout", "-q", "-b", "feature"]).unwrap();
        std::fs::write(base.join("f.txt"), "line1\nfeature\nline2\n").unwrap();
        stage_all(r).unwrap();
        commit(r, "feature change").unwrap();
        run_git(r, &["checkout", "-q", "master"]).unwrap();
        std::fs::write(base.join("f.txt"), "line1\nmaster\nline2\n").unwrap();
        stage_all(r).unwrap();
        commit(r, "master change").unwrap();
        let err = run_git(r, &["merge", "feature"]);
        assert!(err.is_err(), "merge 应产生冲突");
        let cf = conflict_files(r);
        assert!(cf.contains(&"f.txt".to_string()));

        // 手动解决后 finish_merge 应自动完成合并提交
        assert!(conflict_files(r).contains(&"f.txt".to_string()));
        std::fs::write(base.join("f.txt"), "line1\nmerged\nline2\n").unwrap();
        stage_all(r).unwrap();
        let (merged, _) = finish_merge(r).unwrap();
        assert!(merged, "存在 MERGE_HEAD 时应完成合并提交");
        assert!(conflict_files(r).is_empty(), "合并后不应再有冲突");
        // 非合并状态调用返回 false 而非报错
        let (merged2, _) = finish_merge(r).unwrap();
        assert!(!merged2);
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn finish_merge_noop_without_merge() {
        let repo = temp_repo("noopmerge");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        stage_all(r).unwrap();
        commit(r, "init").unwrap();
        let (merged, _) = finish_merge(r).unwrap();
        assert!(!merged, "无 MERGE_HEAD 时不应合并");
        std::fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn log_and_reset_hard() {
        let repo = temp_repo("logreset");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "v1").unwrap();
        stage_all(r).unwrap();
        commit(r, "first").unwrap();
        std::fs::write(repo.join("a.txt"), "v2").unwrap();
        stage_all(r).unwrap();
        commit(r, "second").unwrap();

        let commits = log(r, 10);
        assert_eq!(commits.len(), 2, "应解析出 2 条提交");
        assert_eq!(commits[0].subject, "second", "按时间倒序");
        assert_eq!(commits[0].short.len(), 7, "短 hash 为 7 位");
        assert!(head_hash(r).as_deref() == Some(commits[0].hash.as_str()));

        // 强制回退到 first
        reset_hard(r, &commits[1].hash).unwrap();
        let commits2 = log(r, 10);
        assert_eq!(commits2.len(), 1);
        assert_eq!(commits2[0].subject, "first");
        assert_eq!(head_hash(r).as_deref(), Some(commits2[0].hash.as_str()));
        std::fs::remove_dir_all(repo).ok();
    }
}

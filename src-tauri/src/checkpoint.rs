//! 存档点(Checkpoint):为 AI 开发者提供"游戏存档"式的版本快照。
//!
//! 打点时用临时 index(`GIT_INDEX_FILE`)+`git add -A`+`write-tree` 构造出
//! 包含**未跟踪文件**的工作区完整快照 tree,做成 commit 挂到
//! `refs/checkpoints/<id>` 防 gc。读档时 reset --hard 回存档点 HEAD,
//! 再 read-tree --reset -u 把工作区恢复成快照,clean -fd 清掉多余未跟踪文件。
//!
//! 为什么不用 `git stash create -u`:git 的 stash create 子命令会静默忽略
//! `-u`/`--include-untracked`,未跟踪文件进不了 stash;而 stash push -u
//! 会污染 refs/stash 栈及其 reflog。临时 index 方案既完整又不污染用户状态。

use crate::git::{run_git, run_git_env};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单个存档点
#[derive(Serialize, Deserialize, Clone)]
pub struct Checkpoint {
    /// 唯一标识(epoch_nanos)
    pub id: String,
    /// 创建时间(epoch 秒,与 commit.timestamp 一致,前端按秒算相对时间)
    pub timestamp: i64,
    /// 可选标签
    pub label: Option<String>,
    /// 打点时的 HEAD oid
    pub head: String,
    /// 工作区完整快照的 commit hash(commit-tree 构造,已挂在 refs/checkpoints/<id> 防 gc)
    pub snap: String,
}

/// 存档点上限:超出删最旧的(并删除其 ref)
const MAX_CHECKPOINTS: usize = 20;

/// 解析仓库的真实 .git 目录(对 worktree 友好;复用 git.rs/finish_merge 同款逻辑)
pub fn git_dir(repo: &str) -> Result<PathBuf, String> {
    let gd = run_git(repo, &["rev-parse", "--git-dir"])?;
    let gd_path = std::path::Path::new(gd.trim());
    let dir = if gd_path.is_absolute() {
        gd_path.to_path_buf()
    } else {
        std::path::Path::new(repo).join(gd_path)
    };
    Ok(dir)
}

fn checkpoints_path(repo: &str) -> Result<PathBuf, String> {
    Ok(git_dir(repo)?.join("checkpoints.json"))
}

/// 读取存档点列表(文件缺失/损坏一律返回空,绝不报错)
fn load(repo: &str) -> Vec<Checkpoint> {
    let path = match checkpoints_path(repo) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 原子写入存档点列表(tmp + rename,避免写一半崩溃损坏)
fn save(repo: &str, list: &[Checkpoint]) -> Result<(), String> {
    let path = checkpoints_path(repo)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn now_secs_nanos() -> (i64, String) {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (dur.as_secs() as i64, format!("{}", dur.as_nanos()))
}

/// 构造"工作区完整快照"的 commit(含未跟踪文件),挂到 refs/checkpoints/<id> 防 gc。
/// 临时 index 文件用完即删,绝不污染真 index。
fn build_snapshot(repo: &str, id: &str, head: &str) -> Result<String, String> {
    let gitdir = git_dir(repo)?;
    let tmp_index = gitdir.join(format!("cp-index-{id}"));
    let tmp_index_str = tmp_index.to_string_lossy().to_string();
    let env: &[(&str, &str)] = &[("GIT_INDEX_FILE", tmp_index_str.as_str())];

    let result = (|| {
        // 1. 临时 index 初始化为 HEAD 的 tree
        run_git_env(repo, &["read-tree", "HEAD"], env)?;
        // 2. 把工作区所有改动(含未跟踪,排除 ignored)并入临时 index
        run_git_env(repo, &["add", "-A"], env)?;
        // 3. 写出完整 tree(此刻临时 index = 工作区全部内容)
        let tree = run_git_env(repo, &["write-tree"], env)?.trim().to_string();
        // 4. 构造快照 commit(parent=head,语义清晰且对象可达)
        let snap = run_git(
            repo,
            &["commit-tree", &tree, "-p", head, "-m", &format!("checkpoint {id}")],
        )?
        .trim()
        .to_string();
        // 5. 挂到独立 ref,防止 gc 回收
        run_git(repo, &["update-ref", &format!("refs/checkpoints/{id}"), &snap])?;
        Ok::<String, String>(snap)
    })();

    // 无论成败都清理临时 index 文件
    let _ = std::fs::remove_file(&tmp_index);
    result
}

/// 创建存档点。需要仓库已有至少一个 commit(unborn 仓库会报错)。
pub fn create(repo: &str, label: Option<String>) -> Result<Checkpoint, String> {
    // HEAD oid;unborn 仓库(无首个 commit)rev-parse HEAD 会失败
    let head = run_git(repo, &["rev-parse", "HEAD"])
        .map_err(|_| "请先创建第一个提交后再使用存档点".to_string())?
        .trim()
        .to_string();

    let (timestamp, id) = now_secs_nanos();
    let snap = build_snapshot(repo, &id, &head)?;

    let cp = Checkpoint { id: id.clone(), timestamp, label, head, snap };

    let mut list = load(repo);
    list.push(cp.clone());
    // 超出上限:删最旧的(同时移除其 ref,让对象可被 gc)
    if list.len() > MAX_CHECKPOINTS {
        let drained: Vec<Checkpoint> = list.drain(0..(list.len() - MAX_CHECKPOINTS)).collect();
        for old in drained {
            let _ = run_git(repo, &["update-ref", "-d", &format!("refs/checkpoints/{}", old.id)]);
        }
    }
    save(repo, &list)?;
    Ok(cp)
}

/// 列出全部存档点(按时间升序)
pub fn list(repo: &str) -> Vec<Checkpoint> {
    load(repo)
}

/// 读档:回到指定存档点的完整状态(HEAD + 工作区,含当时的未跟踪文件)。
/// 1) reset --hard <head>:HEAD 回存档点,丢弃之后的提交与改动
/// 2) read-tree --reset -u <snap>:工作区/index 恢复成存档快照(不动 HEAD)
/// 3) clean -fd:清除不属于快照的残留未跟踪文件
pub fn restore(repo: &str, id: &str) -> Result<(), String> {
    let cp = load(repo)
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "找不到该存档点".to_string())?;

    run_git(repo, &["reset", "--hard", &cp.head])?;
    run_git(repo, &["read-tree", "--reset", "-u", &cp.snap])?;
    run_git(repo, &["clean", "-fd"])?;
    Ok(())
}

/// 删除存档点(移除标记 + 删除 ref,git 对象由 gc 自然回收)
pub fn delete(repo: &str, id: &str) -> Result<(), String> {
    let mut list = load(repo);
    let before = list.len();
    list.retain(|c| c.id != id);
    if list.len() == before {
        return Err("找不到该存档点".to_string());
    }
    save(repo, &list)?;
    let _ = run_git(repo, &["update-ref", "-d", &format!("refs/checkpoints/{id}")]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hellogitty-cp-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = dir.to_str().unwrap();
        run_git(r, &["init", "-q"]).unwrap();
        run_git(r, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(r, &["config", "user.name", "test"]).unwrap();
        dir
    }

    fn commit(repo: &str, msg: &str) {
        run_git(repo, &["add", "-A"]).unwrap();
        run_git(repo, &["commit", "-q", "-m", msg]).unwrap();
    }

    #[test]
    fn create_restore_roundtrip() {
        let repo = temp_repo("roundtrip");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "v1").unwrap();
        commit(r, "init");

        // 打点(工作区干净):快照 tree 应等于 HEAD
        let cp1 = create(r, None).unwrap();
        assert!(cp1.snap.len() >= 7, "snap 应是合法 commit hash");

        // 改动工作区(修改 + 新建未跟踪)再读档,应完全还原
        std::fs::write(repo.join("a.txt"), "v2-dirty").unwrap();
        std::fs::write(repo.join("b.txt"), "new untracked").unwrap();
        restore(r, &cp1.id).unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v1");
        assert!(!repo.join("b.txt").exists(), "未跟踪文件应被读档清除");

        // 带改动打点:a.txt=v3 + 未跟踪 c.txt(验证 AI 新建文件能被快照保存)
        std::fs::write(repo.join("a.txt"), "v3").unwrap();
        std::fs::write(repo.join("c.txt"), "tracked by checkpoint").unwrap();
        let cp2 = create(r, Some("带改动".into())).unwrap();

        // 继续搞乱:改 a.txt、删 c.txt、新建 d.txt
        std::fs::write(repo.join("a.txt"), "v4-more").unwrap();
        std::fs::remove_file(repo.join("c.txt")).unwrap();
        std::fs::write(repo.join("d.txt"), "dirty again").unwrap();

        // 读档回 cp2:a.txt=v3、未跟踪 c.txt 恢复、d.txt 消失
        restore(r, &cp2.id).unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v3");
        assert!(repo.join("c.txt").exists(), "存档点应恢复未跟踪文件 c.txt");
        assert!(!repo.join("d.txt").exists(), "读档后不应有 d.txt");

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn restore_drops_commits_after_checkpoint() {
        // 硬读档语义:读档丢弃存档点之后的 commit
        let repo = temp_repo("dropcommits");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "v1").unwrap();
        commit(r, "init");

        let cp = create(r, None).unwrap();

        // 打点后做新 commit(HEAD 前进)
        std::fs::write(repo.join("a.txt"), "v2").unwrap();
        commit(r, "second");
        let head_before = run_git(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert_ne!(head_before, cp.head, "前置:打点后应有新 commit");

        // 读档:HEAD 应回到 cp.head,second commit 被丢弃
        restore(r, &cp.id).unwrap();
        let head_after = run_git(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert_eq!(head_after, cp.head, "读档应把 HEAD 回退到存档点");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v1");

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn unborn_repo_rejected() {
        let repo = temp_repo("unborn");
        let r = repo.to_str().unwrap();
        // 不做首次 commit,直接打点应报错
        assert!(create(r, None).is_err());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn list_and_delete() {
        let repo = temp_repo("listdel");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        commit(r, "init");

        let cp1 = create(r, None).unwrap();
        let cp2 = create(r, None).unwrap();
        assert_eq!(list(r).len(), 2);
        // ref 已建立(防 gc)
        assert!(run_git(r, &["rev-parse", "--verify", &format!("refs/checkpoints/{}", cp1.id)]).is_ok());

        delete(r, &cp1.id).unwrap();
        let remaining = list(r);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, cp2.id, "应只删除指定 id");
        // ref 已移除
        assert!(run_git(r, &["rev-parse", "--verify", &format!("refs/checkpoints/{}", cp1.id)]).is_err());

        // 删除不存在的 id 报错
        assert!(delete(r, "nonexistent").is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn max_cap_trims_oldest() {
        let repo = temp_repo("cap");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        commit(r, "init");
        for _ in 0..(MAX_CHECKPOINTS + 5) {
            create(r, None).unwrap();
        }
        assert_eq!(list(r).len(), MAX_CHECKPOINTS, "超过上限应裁剪到上限");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn corrupt_json_recovers_as_empty() {
        let repo = temp_repo("corrupt");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        commit(r, "init");
        // 写一个损坏的 checkpoints.json,list 不应 panic 而是返回空
        let path = git_dir(r).unwrap().join("checkpoints.json");
        std::fs::write(&path, "{ 这不是合法 json").unwrap();
        assert!(list(r).is_empty(), "损坏的元信息应静默回退为空");
        // create 仍能正常工作(覆盖损坏文件)
        create(r, None).unwrap();
        assert_eq!(list(r).len(), 1);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn real_index_not_polluted() {
        // 关键不变量:打点用临时 index,绝不污染用户真 index
        let repo = temp_repo("nopollute");
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("a.txt"), "v1").unwrap();
        commit(r, "init");

        // 制造一个"未暂存的工作区改动"
        std::fs::write(repo.join("a.txt"), "v2-unstaged").unwrap();
        std::fs::write(repo.join("b.txt"), "untracked").unwrap();
        // 打点前:无已暂存内容
        let staged_before = run_git(r, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged_before.trim().is_empty(), "前置:无暂存内容");

        create(r, None).unwrap();

        // 打点后:真 index 仍应无暂存内容(临时 index 没影响真 index)
        let staged_after = run_git(r, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged_after.trim().is_empty(), "打点不应污染真 index");
        // 临时 index 文件应被清理
        assert!(git_dir(r).unwrap().read_dir().unwrap().all(|e| {
            !e.as_ref().map(|e| e.file_name().to_string_lossy().starts_with("cp-index-")).unwrap_or(false)
        }));
        // 工作区改动仍在(打点不改动工作区)
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v2-unstaged");
        assert!(repo.join("b.txt").exists());

        std::fs::remove_dir_all(&repo).ok();
    }
}

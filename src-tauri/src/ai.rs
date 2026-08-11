use crate::git;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_CONFLICT_FILE_BYTES: usize = 80_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 提交信息语言:"中文" 或 "英文"
    pub lang: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
            lang: "中文".into(),
        }
    }
}

async fn chat(cfg: &AiConfig, system: &str, user: &str) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("尚未配置 AI API Key,请点击右上角设置完成配置".into());
    }
    let base = cfg.base_url.trim().trim_end_matches('/');
    let url = format!("{base}/chat/completions");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.3
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 AI 服务失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("AI 服务返回错误({status}): {text}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "AI 服务响应解析失败".to_string())?;
    let content = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| "AI 服务响应中缺少内容".to_string())?;
    Ok(clean_markdown(content.trim().to_string()))
}

/// 去除模型常见的 ``` 代码块包裹
fn clean_markdown(s: String) -> String {
    let s = s.trim();
    if s.starts_with("```") && s.ends_with("```") {
        let mut lines = s.lines();
        let _ = lines.next();
        let mut out = Vec::new();
        let mut it = lines.peekable();
        while let Some(l) = it.next() {
            if it.peek().is_none() && l.trim() == "```" {
                break;
            }
            out.push(l);
        }
        return out.join("\n").trim().to_string();
    }
    s.to_string()
}

pub async fn generate_commit_message(cfg: &AiConfig, repo: &str) -> Result<String, String> {
    let diff = git::diff_for_ai(repo)?;
    let log = git::recent_log(repo, 8);
    let mut style_hint = String::new();
    if !log.is_empty() {
        style_hint = format!("\n仓库近期的提交风格参考:\n{}\n", log.join("\n"));
    }
    let lang_rule = match cfg.lang.as_str() {
        "英文" => "Write the subject and body in English.",
        _ => "用简体中文撰写主题与正文。",
    };
    let system = "你是一名资深软件工程师,负责为代码变更撰写简洁、专业的 git 提交信息。遵循 Conventional Commits 规范(type: subject),主语用祈使句,主题不超过 72 字符,正文说明变更的原因与影响,必要时给出要点列表。只输出提交信息本身,不要任何解释或代码块标记。";
    let user = format!(
        "{lang_rule}\n\n{style_hint}\n以下是本次要提交的全部变更:\n\n{diff}\n\n请生成提交信息。"
    );
    let msg = chat(cfg, system, &user).await?;
    if msg.is_empty() {
        return Err("AI 未生成提交信息".into());
    }
    Ok(msg)
}

pub async fn resolve_conflict_file(cfg: &AiConfig, repo: &str, path: &str) -> Result<(), String> {
    let full = Path::new(repo).join(path);
    let content = std::fs::read_to_string(&full)
        .map_err(|e| format!("读取 {path} 失败: {e}"))?;
    if content.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(format!("{path} 过大({}KB),超出 AI 处理上限,请手动解决", content.len() / 1024));
    }
    if !content.contains("<<<<<<<") && !content.contains("=======") {
        // 无冲突标记(例如文件级删除冲突),跳过
        return Err(format!("{path} 未包含冲突标记,请手动处理"));
    }
    let system = "你是一名擅长解决 git 合并冲突的资深工程师。合并冲突时保留双方代码的正确意图,保证语法与语义正确,不留下任何冲突标记(<<<<<<< ======= >>>>>>>),也不添加解释性文字。只输出合并后的完整文件内容。";
    let user = format!("文件路径:{path}\n\n文件内容(含冲突标记):\n```\n{content}\n```\n\n请输出解决冲突后的完整文件内容。");
    let resolved = chat(cfg, system, &user).await?;
    // 防御:AI 可能再次包上代码块
    let resolved = clean_markdown(resolved);
    std::fs::write(&full, resolved).map_err(|e| format!("写入 {path} 失败: {e}"))?;
    git::stage_file(repo, path)?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct ConflictOutcome {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

pub async fn resolve_all_conflicts(
    cfg: &AiConfig,
    repo: &str,
    on_progress: impl Fn(usize, usize, &str) + Send + Sync + 'static,
) -> Result<Vec<ConflictOutcome>, String> {
    let files = git::conflict_files(repo);
    if files.is_empty() {
        return Err("当前没有待解决的冲突".into());
    }
    let total = files.len();
    let mut outcomes = Vec::with_capacity(total);
    for (i, path) in files.iter().enumerate() {
        on_progress(i + 1, total, path);
        match resolve_conflict_file(cfg, repo, path).await {
            Ok(()) => outcomes.push(ConflictOutcome { path: path.clone(), ok: true, error: None }),
            Err(e) => outcomes.push(ConflictOutcome { path: path.clone(), ok: false, error: Some(e) }),
        }
    }
    Ok(outcomes)
}

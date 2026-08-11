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
    /// 提交模式:"auto" 直接提交(AI 生成后自动提交) / "confirm" 生成后展示确认
    #[serde(default = "default_commit_mode")]
    pub commit_mode: String,
    /// 提交信息提示词预设 id("custom" 表示使用 custom_prompt)
    #[serde(default = "default_preset")]
    pub prompt_preset: String,
    /// 自定义提示词模板(占位符:{diff} {log} {lang})
    #[serde(default)]
    pub custom_prompt: String,
}

fn default_commit_mode() -> String {
    "auto".into()
}

fn default_preset() -> String {
    "conventional".into()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
            lang: "中文".into(),
            commit_mode: default_commit_mode(),
            prompt_preset: default_preset(),
            custom_prompt: String::new(),
        }
    }
}

/// 内置提交信息提示词预设
#[derive(Serialize, Clone)]
pub struct PromptPreset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system: String,
    /// user 提示模板,支持 {diff} {log} {lang} 占位符
    pub user_template: String,
}

const USER_TAIL: &str = "\n\n以下是本次要提交的全部变更:\n\n{diff}\n\n请生成提交信息。";

pub fn presets() -> Vec<PromptPreset> {
    vec![
        PromptPreset {
            id: "conventional".into(),
            name: "常规提交".into(),
            description: "Conventional Commits 规范,主题 + 正文,语言跟随上方设置".into(),
            system: "你是一名资深软件工程师,负责为代码变更撰写简洁、专业的 git 提交信息。遵循 Conventional Commits 规范(type: subject),主语用祈使句,主题不超过 72 字符,正文说明变更的原因与影响,必要时给出要点列表。只输出提交信息本身,不要任何解释或代码块标记。".into(),
            user_template: format!("{{lang}}\n\n{{log}}{}", USER_TAIL),
        },
        PromptPreset {
            id: "concise".into(),
            name: "极简一句".into(),
            description: "只输出一行主题,不超过 72 字符".into(),
            system: "你是一名资深软件工程师,为代码变更撰写一行式 git 提交信息。用祈使句概括变更,不超过 72 字符,遵循 Conventional Commits 规范(type: subject)。只输出提交信息本身,不要解释或代码块标记。".into(),
            user_template: "{lang}\n\n{log}\n\n以下是本次要提交的全部变更:\n\n{diff}\n\n请只生成一行提交信息。".into(),
        },
        PromptPreset {
            id: "detailed".into(),
            name: "详尽报告".into(),
            description: "主题 + 详细正文,覆盖背景、影响范围与注意事项".into(),
            system: "你是一名资深软件工程师,为代码变更撰写详尽的 git 提交信息。遵循 Conventional Commits 规范:主题后空一行接正文。正文说明变更背景、具体内容、影响范围与注意事项,使用要点列表组织。只输出提交信息本身,不要代码块标记。".into(),
            user_template: "{lang}\n\n{log}\n\n以下是本次要提交的全部变更:\n\n{diff}\n\n请生成提交信息(主题 + 详细正文)。".into(),
        },
        PromptPreset {
            id: "gitmoji".into(),
            name: "Gitmoji 表情".into(),
            description: "以表情符号开头(✨ 新功能 / 🐛 修复 / 📝 文档…),中文开发者常用".into(),
            system: "你是一名资深软件工程师,使用 Gitmoji 规范撰写 git 提交信息:以合适的表情符号开头(如 ✨ 新功能、🐛 修复、📝 文档、♻️ 重构、🚀 性能),后接简短主题,必要时附正文。只输出提交信息本身,不要代码块标记。".into(),
            user_template: "{lang}\n\n{log}\n\n以下是本次要提交的全部变更:\n\n{diff}\n\n请生成 Gitmoji 风格的提交信息。".into(),
        },
    ]
}

pub fn preset_by_id(id: &str) -> Option<PromptPreset> {
    presets().into_iter().find(|p| p.id == id)
}

/// 根据语言设置生成注入模板的语言指令
pub fn lang_instruction(lang: &str) -> String {
    match lang {
        "英文" => "请用英文撰写提交信息(Write the commit message in English)。".into(),
        _ => "请用简体中文撰写提交信息。".into(),
    }
}

/// 渲染提示词模板:替换 {lang} {log} {diff} 占位符
pub fn render_template(template: &str, diff: &str, log_hint: &str, lang: &str) -> String {
    template
        .replace("{lang}", lang)
        .replace("{log}", log_hint)
        .replace("{diff}", diff)
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
    // 提交语义:只提交已暂存内容,AI 信息基于暂存差异
    let diff = git::diff_for_ai(repo, true)?;
    let log = git::recent_log(repo, 8);
    let log_hint = if log.is_empty() {
        String::new()
    } else {
        format!("仓库近期的提交风格参考:\n{}\n", log.join("\n"))
    };
    let lang = lang_instruction(&cfg.lang);

    // 选择提示词:自定义优先(模板非空时),否则按预设 id 匹配,兜底常规提交
    let (system, user) = if cfg.prompt_preset == "custom" && !cfg.custom_prompt.trim().is_empty() {
        let default_system = preset_by_id("conventional").map(|p| p.system).unwrap_or_default();
        (default_system, render_template(&cfg.custom_prompt, &diff, &log_hint, &lang))
    } else {
        let p = preset_by_id(&cfg.prompt_preset)
            .or_else(|| preset_by_id("conventional"))
            .expect("conventional 预设必然存在");
        (p.system, render_template(&p.user_template, &diff, &log_hint, &lang))
    };

    let msg = chat(cfg, &system, &user).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_placeholders() {
        let out = render_template("{lang} | {log} | {diff}", "DIFF", "LOG", "LANG");
        assert_eq!(out, "LANG | LOG | DIFF");
    }

    #[test]
    fn presets_lookup_and_fallback() {
        assert!(preset_by_id("conventional").is_some());
        assert!(preset_by_id("custom").is_none(), "custom 不应是内置预设");
        assert!(preset_by_id("nonexistent").is_none());
        // 全部预设的 user 模板必须包含 diff 占位符
        for p in presets() {
            assert!(p.user_template.contains("{diff}"), "{} 模板缺 {{diff}}", p.id);
        }
    }

    #[test]
    fn lang_instruction_both() {
        assert!(lang_instruction("中文").contains("简体中文"));
        assert!(lang_instruction("英文").contains("English"));
    }

    #[test]
    fn default_commit_mode_is_auto() {
        assert_eq!(AiConfig::default().commit_mode, "auto");
    }
}

use crate::git;
use futures_util::StreamExt;
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
            base_url: "https://api.deepseek.com".into(),
            api_key: String::new(),
            model: "deepseek-v4-flash".into(),
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

const USER_TAIL: &str = "\n\n以下是本次要提交的全部变更（diff）：\n\n{diff}\n\n请严格按系统消息中的格式生成提交信息：必须包含主题行与正文，正文用要点说明变更原因与主要改动，不要只输出一句话。";

pub fn presets() -> Vec<PromptPreset> {
    vec![
        PromptPreset {
            id: "conventional".into(),
            name: "常规提交".into(),
            description: "Conventional Commits 规范，主题 + 正文，语言跟随上方设置".into(),
            system: "你是一名资深软件工程师，严格遵循 Conventional Commits 等社区最佳实践为代码变更撰写 git 提交信息。\n\n\
【输出格式】主题与正文缺一不可，结构如下：\n\
<type>(<scope>): <subject>\n\
（空行）\n\
<body>\n\n\
【规则】\n\
- type 选自：feat 新功能 / fix 修复 / docs 文档 / style 格式 / refactor 重构 / perf 性能 / test 测试 / build 构建 / ci 持续集成 / chore 杂务；无法判断时用 chore\n\
- scope 可选，表示影响范围（模块或文件）\n\
- subject：祈使句，概括「做了什么」，不超过 50 字，句末不加句号\n\
- body：说明「为什么改」与「主要改了什么」，多项改动用「- 」列要点；不要逐行复述 diff；每行不超过 72 字\n\n\
【示例】\n\
feat(auth): 支持基于 OAuth 的第三方登录\n\n\
- 新增 OAuth 回调处理与 token 自动刷新\n\
- 登录页加入第三方登录入口\n\
- 抽象统一登录接口，便于后续扩展\n\n\
只输出提交信息本身，不要用 ``` 代码块包裹，不要任何前言或解释。".into(),
            user_template: format!("{{lang}}\n\n{{log}}{}", USER_TAIL),
        },
    ]
}

pub fn preset_by_id(id: &str) -> Option<PromptPreset> {
    presets().into_iter().find(|p| p.id == id)
}

/// 根据语言设置生成注入模板的语言指令
pub fn lang_instruction(lang: &str) -> String {
    match lang {
        "英文" => "请用英文撰写提交信息（Write the commit message in English）。".into(),
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
        return Err("尚未配置 AI API Key，请先打开设置完成配置".into());
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
        .map_err(|e| format!("请求 AI 服务失败： {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("AI 服务返回错误（{status}）： {text}"));
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

/// 构建提交信息的 (system, user) 提示词:暂存差异 + 近期提交参考 + 常规提交预设 + 用户额外要求
fn build_commit_prompt(cfg: &AiConfig, repo: &str) -> Result<(String, String), String> {
    // 提交语义:只提交已暂存内容,AI 信息基于暂存差异
    let diff = git::diff_for_ai(repo, true)?;
    let log = git::recent_log(repo, 8);
    let log_hint = if log.is_empty() {
        String::new()
    } else {
        format!("以下是该仓库近期的提交记录，仅供你参考 type 前缀与语言习惯，不要照搬其长度或结构：\n{}\n", log.join("\n"))
    };
    let lang = lang_instruction(&cfg.lang);

    // 固定使用最佳实践预设(常规提交)作为提示词引擎;用户填写的「额外要求」是最高优先级指令,
    // 与预设/语言/近期记录等任何其他规则冲突时一律以它为准,同时注入 system 与 user 双保险
    let p = preset_by_id("conventional").expect("conventional 预设必然存在");
    let extra = cfg.custom_prompt.trim();
    let system = if extra.is_empty() {
        p.system.clone()
    } else {
        format!(
            "{}\n\n【用户额外要求·最高优先级】这是用户对本次提交信息的硬性要求，优先于以上所有规则（包括语言、格式、长度约定）:\n{}",
            p.system,
            extra
        )
    };
    // 有额外要求时不再注入语言指令:语言归属额外要求管辖,避免与硬编码默认(中文)互相矛盾
    let lang_for_user = if extra.is_empty() {
        lang
    } else {
        String::new()
    };
    let user = render_template(&p.user_template, &diff, &log_hint, &lang_for_user);
    // 额外要求贴近 diff 注入 user 消息:紧邻输入内容的位置模型遵循度最高
    let user = if extra.is_empty() {
        user
    } else {
        format!(
            "{}\n\n【用户额外要求·最高优先级】与系统消息中的任何规则冲突时，一律按以下要求执行：\n{}",
            user,
            extra
        )
    };
    Ok((system, user))
}

pub async fn generate_commit_message(cfg: &AiConfig, repo: &str) -> Result<String, String> {
    let (system, user) = build_commit_prompt(cfg, repo)?;
    let msg = chat(cfg, &system, &user).await?;
    if msg.is_empty() {
        return Err("AI 未生成提交信息".into());
    }
    Ok(msg)
}

/// 流式生成提交信息:逐 token 经 on_delta 回调推送已累积的全文,最终返回(已去围栏)全文。
/// on_delta 收到的是当前累积的完整文本,前端可直接整体回填,避免增量拼接。
pub async fn generate_commit_message_stream(
    cfg: &AiConfig,
    repo: &str,
    on_delta: impl Fn(&str) + Send + Sync + 'static,
) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("尚未配置 AI API Key，请先打开设置完成配置".into());
    }
    let (system, user) = build_commit_prompt(cfg, repo)?;
    let base = cfg.base_url.trim().trim_end_matches('/');
    let url = format!("{base}/chat/completions");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.3,
        "stream": true
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 AI 服务失败： {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // 流式接口出错时 body 仍是普通 JSON 错误
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI 服务返回错误（{status}）： {text}"));
    }

    // SSE 流式解析:按字节块读入行缓冲,提取 `data: {...}` 中的 choices[0].delta.content
    let mut stream = resp.bytes_stream();
    // 按字节缓冲:网络分块边界落在任意字节上,多字节字符(如中文)可能被劈在
    // 两个 chunk 里,对整块做 from_utf8 会误报"非法 UTF-8";只对完整行解码
    // (\n 的字节值不会出现在 UTF-8 多字节序列中,按字节切行是安全的)
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("读取 AI 流式响应失败： {e}"))?;
        buf.extend_from_slice(&bytes);
        // 处理缓冲里所有完整行
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line["data:".len()..].trim();
            if data == "[DONE]" {
                let result = clean_markdown(full.clone());
                on_delta(&result);
                return Ok(result);
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                    full.push_str(delta);
                    on_delta(&full);
                }
            }
        }
    }
    // 流自然结束(未收到 [DONE])— 兜底返回累积内容
    if full.trim().is_empty() {
        return Err("AI 未生成提交信息".into());
    }
    let result = clean_markdown(full);
    on_delta(&result);
    Ok(result)
}

pub async fn resolve_conflict_file(cfg: &AiConfig, repo: &str, path: &str) -> Result<(), String> {
    let full = Path::new(repo).join(path);
    let content = std::fs::read_to_string(&full)
        .map_err(|e| format!("读取 {path} 失败： {e}"))?;
    if content.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(format!("{path} 过大（{}KB），超出 AI 处理上限，请手动解决", content.len() / 1024));
    }
    if !content.contains("<<<<<<<") && !content.contains("=======") {
        // 无冲突标记(例如文件级删除冲突),跳过
        return Err(format!("{path} 未包含冲突标记，请手动处理"));
    }
    let system = "你是一名擅长解决 git 合并冲突的资深工程师。合并冲突时保留双方代码的正确意图，保证语法与语义正确，不留下任何冲突标记（<<<<<<< ======= >>>>>>>），也不添加解释性文字。只输出合并后的完整文件内容。";
    let user = format!("文件路径：{path}\n\n文件内容（含冲突标记）：\n```\n{content}\n```\n\n请输出解决冲突后的完整文件内容。");
    let resolved = chat(cfg, system, &user).await?;
    // 防御:AI 可能再次包上代码块
    let resolved = clean_markdown(resolved);
    std::fs::write(&full, resolved).map_err(|e| format!("写入 {path} 失败： {e}"))?;
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

    /// 临时 git 仓库(与 git.rs 测试同款模式)
    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hellogitty-ai-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = dir.to_str().unwrap();
        crate::git::run_git(r, &["init", "-q"]).unwrap();
        crate::git::run_git(r, &["config", "user.email", "test@example.com"]).unwrap();
        crate::git::run_git(r, &["config", "user.name", "test"]).unwrap();
        dir
    }

    #[test]
    fn custom_prompt_is_highest_priority() {
        let repo = temp_repo("custom-prompt");
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        crate::git::run_git(repo.to_str().unwrap(), &["add", "a.txt"]).unwrap();

        let base = AiConfig {
            custom_prompt: "使用英文撰写提交信息".into(),
            ..AiConfig::default()
        };
        let (system, user) = build_commit_prompt(&base, repo.to_str().unwrap()).unwrap();

        // system 与 user 都包含最高优先级声明 + 用户原文
        assert!(system.contains("最高优先级"));
        assert!(system.contains("使用英文撰写提交信息"));
        assert!(user.contains("最高优先级"));
        assert!(user.contains("使用英文撰写提交信息"));
        // 有额外要求时,语言指令(简体中文)被抑制,避免与额外要求冲突
        assert!(!user.contains("简体中文"));

        // 无额外要求时保持原行为:语言指令正常注入
        let none = AiConfig::default();
        let (_, user_none) = build_commit_prompt(&none, repo.to_str().unwrap()).unwrap();
        assert!(user_none.contains("简体中文"));
        assert!(!user_none.contains("最高优先级"));

        std::fs::remove_dir_all(repo).ok();
    }
}

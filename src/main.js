/* Hello Gitty 前端逻辑:纯 vanilla,通过 __TAURI__ 全局调用后端命令 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const DEFAULT_AI = { base_url: "https://api.openai.com/v1", api_key: "", model: "gpt-4o-mini", lang: "中文", prompt_preset: "conventional", custom_prompt: "" };
const STATUS_CHARS = { A: "A", M: "M", D: "D", R: "R", C: "C", U: "?", "?": "?" };

let settings = { ai: { ...DEFAULT_AI }, last_repo: null, repos: [] };
let repos = []; // 侧栏仓库摘要列表
let repo = null;
let busy = false;
let toastTimer = null;
let promptPresets = [];

init();

async function init() {
  try {
    settings = await invoke("settings_load");
    settings.ai = { ...DEFAULT_AI, ...settings.ai }; // 兼容旧配置,补齐新字段
    settings.repos = settings.repos || [];
  } catch (_) { settings.repos = []; }
  // 旧配置迁移:last_repo 不在列表时补进列表
  if (settings.last_repo && !settings.repos.includes(settings.last_repo)) {
    settings.repos.push(settings.last_repo);
    try { await invoke("settings_save", { settings }); } catch (_) {}
  }
  repo = settings.last_repo && settings.repos.includes(settings.last_repo)
    ? settings.last_repo
    : (settings.repos[0] || null);

  bindEvents();
  listen("conflict-progress", (e) => {
    const p = e.payload;
    $("conflict-current").textContent = `(${p.done}/${p.total}) ${p.path}`;
    $("conflict-fill").style.width = `${Math.round((p.done / p.total) * 100)}%`;
  });

  await loadRepos();
  if (repo) {
    await refresh();
  } else {
    showEmpty(false);
  }
}

function bindEvents() {
  $("btn-open").addEventListener("click", addRepo);
  $("btn-open2").addEventListener("click", addRepo);
  $("btn-add-repo").addEventListener("click", addRepo);
  $("btn-init").addEventListener("click", initRepo);
  $("btn-refresh").addEventListener("click", () => refresh());
  $("btn-stage-all").addEventListener("click", () => stageAll(true));
  $("btn-unstage-all").addEventListener("click", () => stageAll(false));
  $("btn-commit").addEventListener("click", onCommit);
  $("btn-push").addEventListener("click", () => pushPull("push"));
  $("btn-pull").addEventListener("click", () => pushPull("pull"));
  $("btn-ai-resolve").addEventListener("click", resolveAllConflicts);
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-settings-cancel").addEventListener("click", closeSettings);
  $("btn-settings-save").addEventListener("click", saveSettings);
  $("set-prompt-preset").addEventListener("change", updatePresetPreview);
  $("btn-commit-cancel").addEventListener("click", () => $("dlg-commit").classList.add("hidden"));
  $("btn-commit-confirm").addEventListener("click", doCommit);
  $("btn-regen").addEventListener("click", regenMessage);
  $("btn-conflict-done").addEventListener("click", () => $("dlg-conflict").classList.add("hidden"));

  document.querySelectorAll(".section-head").forEach((h) =>
    h.addEventListener("click", () => {
      const sec = h.closest(".section");
      sec.classList.toggle("collapsed");
      $(h.dataset.target).classList.toggle("hidden");
    })
  );

  $("commit-msg").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit();
  });
}

/* ===== 仓库 ===== */
async function addRepo() {
  const dir = await invoke("pick_folder");
  if (!dir) return;
  try {
    settings.repos = await invoke("repos_add", { path: dir });
  } catch (e) { toast("添加失败:" + e, false); return; }
  repo = dir;
  settings.last_repo = dir;
  try { await invoke("repos_set_current", { path: dir }); } catch (_) {}
  await loadRepos();
  await refresh();
}

async function loadRepos() {
  try { repos = await invoke("repos_status_all"); } catch (_) { repos = []; }
  renderRepoList();
}

function renderRepoList() {
  const ul = $("repo-list");
  ul.innerHTML = "";
  $("sidebar-empty").classList.toggle("hidden", repos.length > 0);
  for (const r of repos) {
    const li = document.createElement("li");
    li.className = "repo-item" + (r.path === repo ? " active" : "");
    li.title = r.path;

    const top = document.createElement("div");
    top.className = "repo-item-top";
    const dot = document.createElement("span");
    const dotClass = !r.is_repo ? "gone"
      : r.conflicts > 0 ? "conflict"
      : (r.staged + r.unstaged > 0 ? "dirty" : "clean");
    dot.className = "repo-dot " + dotClass;
    const name = document.createElement("span");
    name.className = "repo-name";
    name.textContent = r.name;
    const rm = document.createElement("button");
    rm.className = "repo-remove";
    rm.textContent = "×";
    rm.title = "移除仓库";
    rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeRepo(r.path); });
    top.append(dot, name, rm);

    const meta = document.createElement("div");
    meta.className = "repo-meta";
    // 分支与数字都是安全的;仍转义以防路径含特殊字符
    let html = escapeHtml(r.is_repo ? (r.branch || "(无分支)") : "不是 Git 仓库");
    if (r.conflicts) html += ` · <span class="c">${r.conflicts} 冲突</span>`;
    if (r.staged) html += ` · ${r.staged} 暂存`;
    if (r.unstaged) html += ` · ${r.unstaged} 更改`;
    if (r.ahead || r.behind) html += ` · ⇡${r.ahead}⇣${r.behind}`;
    meta.innerHTML = html;

    li.append(top, meta);
    li.addEventListener("click", () => switchRepo(r.path));
    ul.appendChild(li);
  }
}

async function switchRepo(path) {
  if (path === repo) return;
  repo = path;
  settings.last_repo = path;
  try { await invoke("repos_set_current", { path }); } catch (_) {}
  renderRepoList();
  await refresh();
}

async function removeRepo(path) {
  try { settings.repos = await invoke("repos_remove", { path }); }
  catch (e) { toast("移除失败:" + e, false); return; }
  if (repo === path) {
    repo = settings.repos[0] || null;
    settings.last_repo = repo;
  }
  await loadRepos();
  if (repo) await refresh(); else showEmpty(false);
}

async function initRepo() {
  if (!repo) return;
  await runBusy("git_init", { repo }, "初始化中…", "仓库已初始化");
  await refresh();
  await loadRepos();
}

/* ===== 刷新 ===== */
async function refresh() {
  if (!repo) return;
  const st = await invoke("git_status", { repo });
  if (!st.is_repo) {
    showEmpty(true);
    await loadRepos();
    return;
  }
  showPanel(st);
  updateToolbar(st);
  await loadRepos(); // 同步侧栏状态徽标
}

function showEmpty(showInit) {
  $("panel").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  $("btn-init").classList.toggle("hidden", !showInit);
  $("repo-name").textContent = repo ? repo.split("/").pop() : "未打开仓库";
  if (repo) $("repo-name").title = repo;
  $("sb-branch").textContent = "";
  $("sb-ab").textContent = "";
  $("sb-status").textContent = showInit ? "该文件夹还不是 Git 仓库" : "等待选择仓库";
  setToolbarEnabled(false);
}

function showPanel(st) {
  $("empty-state").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("repo-name").textContent = st.repo.split("/").pop() || st.repo;
  $("repo-name").title = st.repo;

  $("sb-branch").textContent = st.detached ? "(分离 HEAD)" : st.branch || "(无分支)";
  $("sb-ab").textContent =
    st.ahead || st.behind ? `${st.ahead ? "⇡" + st.ahead : ""}${st.behind ? " ⇣" + st.behind : ""}` : "";
  $("sb-status").textContent = `${st.staged.length} 暂存 · ${st.unstaged.length + st.untracked.length} 更改`;

  renderList("conflict-list", st.conflicts, "conflict", $("conflict-count"));
  renderList("staged-list", st.staged, "staged", $("staged-count"));
  renderList("unstaged-list", [...st.unstaged, ...st.untracked], "unstaged", $("unstaged-count"));

  $("sec-conflicts").classList.toggle("has-conflicts", st.conflicts.length > 0);
  $("btn-ai-resolve").disabled = st.conflicts.length === 0;
  setToolbarEnabled(true);
  updateToolbar(st);
}

function setToolbarEnabled(enabled) {
  ["btn-stage-all", "btn-unstage-all", "btn-commit", "btn-push", "btn-pull"].forEach((id) => {
    $(id).disabled = !enabled;
  });
}

function updateToolbar(st) {
  const canStage = st.unstaged.length + st.untracked.length > 0;
  const canUnstage = st.staged.length > 0;
  const canCommit = st.staged.length + st.unstaged.length + st.untracked.length > 0;
  $("btn-stage-all").disabled = busy || !canStage;
  $("btn-unstage-all").disabled = busy || !canUnstage;
  $("btn-commit").disabled = busy || !canCommit;
  $("btn-push").disabled = busy;
  $("btn-pull").disabled = busy;
}

/* ===== 文件列表 ===== */
function renderList(listId, entries, kind, countEl) {
  const ul = $(listId);
  ul.innerHTML = "";
  countEl.textContent = entries.length;
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "file-row";

    const st = document.createElement("span");
    st.className = "st st-" + stChar(e, kind);
    st.textContent = stChar(e, kind);
    li.appendChild(st);

    const path = document.createElement("span");
    path.className = "path";
    path.textContent = e.orig_path ? `${e.path} → ${e.orig_path}` : e.path;
    path.title = e.path;
    li.appendChild(path);

    const actions = document.createElement("span");
    actions.className = "row-actions";

    if (kind === "conflict") {
      const b = document.createElement("button");
      b.className = "resolve";
      b.textContent = "AI 解决";
      b.addEventListener("click", (ev) => { ev.stopPropagation(); resolveOne(e.path); });
      actions.appendChild(b);
    } else {
      const b = document.createElement("button");
      b.textContent = kind === "staged" ? "取消暂存" : "暂存";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleStage(e.path, kind === "staged");
      });
      actions.appendChild(b);
    }
    li.appendChild(actions);

    li.addEventListener("click", () => {
      if (kind === "conflict") resolveOne(e.path);
      else toggleStage(e.path, kind === "staged");
    });

    ul.appendChild(li);
  }
}

function stChar(e, kind) {
  if (kind === "conflict") return "C";
  if (e.untracked) return "?";
  if (kind === "staged") return STATUS_CHARS[e.x] || "M";
  return STATUS_CHARS[e.y] || "M";
}

/* ===== 操作 ===== */
async function stageAll(stage) {
  await runBusy(stage ? "git_stage_all" : "git_unstage_all", { repo },
    stage ? "暂存中…" : "取消暂存中…", stage ? "已全部暂存" : "已全部取消暂存");
  await refresh();
}

async function toggleStage(path, unstage) {
  await runBusy(unstage ? "git_unstage_file" : "git_stage_file", { repo, path },
    unstage ? "取消暂存中…" : "暂存中…");
  await refresh();
}

async function onCommit() {
  setBusy(true, "暂存全部修改…");
  try { await invoke("git_stage_all", { repo }); } catch (e) { toast(String(e), false); setBusy(false); return; }

  let msg = "";
  let hint = "AI 未能生成提交信息,请手动填写:";
  try {
    setBusy(true, "AI 撰写提交信息…");
    msg = await invoke("ai_commit_message", { settings: settings.ai, repo });
    hint = "AI 已生成,可修改后提交";
  } catch (e) {
    hint = "AI 生成失败:" + e + " 请手动填写:";
  }
  setBusy(false);
  $("commit-msg").value = msg;
  $("commit-hint").textContent = hint;
  $("dlg-commit").classList.remove("hidden");
  $("commit-msg").focus();
}

async function regenMessage() {
  setBusy(true, "重新生成…");
  try {
    const msg = await invoke("ai_commit_message", { settings: settings.ai, repo });
    $("commit-msg").value = msg;
    $("commit-hint").textContent = "AI 已重新生成,可修改后提交";
  } catch (e) {
    $("commit-hint").textContent = "AI 生成失败:" + e;
  }
  setBusy(false);
}

async function doCommit() {
  const msg = $("commit-msg").value.trim();
  if (!msg) { toast("提交信息不能为空", false); return; }
  $("dlg-commit").classList.add("hidden");
  await runBusy("git_commit", { repo, message: msg }, "提交中…", "提交成功");
  await refresh();
}

async function pushPull(kind) {
  const label = kind === "push" ? "推送" : "拉取";
  setBusy(true, `${label}中…`);
  try {
    const r = await invoke(kind === "push" ? "git_push" : "git_pull", { repo });
    toast(r.output, r.ok);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setBusy(false);
    await refresh();
  }
}

/* ===== AI 冲突解决 ===== */
async function resolveAllConflicts() {
  $("conflict-current").textContent = "准备中…";
  $("conflict-fill").style.width = "0%";
  $("conflict-detail").textContent = "";
  $("btn-conflict-done").disabled = true;
  $("dlg-conflict").classList.remove("hidden");
  setBusy(true, "AI 解决冲突中…");
  try {
    const results = await invoke("ai_resolve_conflicts", { settings: settings.ai, repo });
    const okN = results.filter((r) => r.ok).length;
    const failN = results.length - okN;
    $("conflict-detail").textContent = failN
      ? `成功 ${okN} 个,失败 ${failN} 个:` + results.filter((r) => !r.ok).map((r) => `\n• ${r.path}: ${r.error}`).join("")
      : `全部 ${okN} 个冲突已由 AI 解决,文件已暂存`;
    toast(failN ? `解决 ${okN} 个,${failN} 个失败` : "冲突已全部解决", failN === 0);
  } catch (e) {
    $("conflict-detail").textContent = String(e);
    toast(String(e), false);
  } finally {
    setBusy(false);
    $("btn-conflict-done").disabled = false;
    await refresh();
  }
}

async function resolveOne(path) {
  await runBusy("ai_resolve_file", { settings: settings.ai, repo, path }, "AI 解决中…", "已解决:" + path);
  await refresh();
}

/* ===== 设置 ===== */
async function openSettings() {
  $("set-base-url").value = settings.ai.base_url || DEFAULT_AI.base_url;
  $("set-api-key").value = settings.ai.api_key || "";
  $("set-model").value = settings.ai.model || DEFAULT_AI.model;
  $("set-lang").value = settings.ai.lang || "中文";
  $("set-custom-prompt").value = settings.ai.custom_prompt || "";

  // 加载内置提示词预设
  try { promptPresets = await invoke("ai_presets"); } catch (_) { promptPresets = []; }
  const sel = $("set-prompt-preset");
  sel.innerHTML = "";
  for (const p of promptPresets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "custom";
  customOpt.textContent = "自定义…";
  sel.appendChild(customOpt);
  sel.value = settings.ai.prompt_preset || "conventional";

  updatePresetPreview();
  $("dlg-settings").classList.remove("hidden");
}

function updatePresetPreview() {
  const id = $("set-prompt-preset").value;
  $("custom-prompt-field").classList.toggle("hidden", id !== "custom");
  const box = $("preset-preview");
  if (id === "custom") {
    box.classList.add("hidden");
    return;
  }
  const p = promptPresets.find((x) => x.id === id);
  if (!p) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="pp-title">${escapeHtml(p.name)}</div>` +
    `<div class="pp-desc">${escapeHtml(p.description)}</div>` +
    `<div class="pp-label">系统提示词(system)</div>` +
    `<pre>${escapeHtml(p.system)}</pre>` +
    `<div class="pp-label">用户提示词模板(user,占位符会被替换)</div>` +
    `<pre>${escapeHtml(p.user_template)}</pre>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function closeSettings() { $("dlg-settings").classList.add("hidden"); }

async function saveSettings() {
  settings.ai = {
    base_url: $("set-base-url").value.trim() || DEFAULT_AI.base_url,
    api_key: $("set-api-key").value.trim(),
    model: $("set-model").value.trim() || DEFAULT_AI.model,
    lang: $("set-lang").value,
    prompt_preset: $("set-prompt-preset").value,
    custom_prompt: $("set-custom-prompt").value,
  };
  try {
    await invoke("settings_save", { settings });
    closeSettings();
    toast("设置已保存", true);
  } catch (e) {
    toast("保存失败:" + e, false);
  }
}

/* ===== 通用 ===== */
async function runBusy(cmd, args, busyText, okText) {
  setBusy(true, busyText);
  try {
    const r = await invoke(cmd, args);
    if (r && r.ok === false) toast(r.output, false);
    else if (okText) toast(okText, true);
    return r;
  } catch (e) {
    toast(String(e), false);
    return null;
  } finally {
    setBusy(false);
  }
}

function setBusy(v, text) {
  busy = v;
  $("sb-busy").classList.toggle("hidden", !v);
  if (text) $("sb-busy-text").textContent = text;
  ["btn-stage-all", "btn-unstage-all", "btn-commit", "btn-push", "btn-pull", "btn-refresh"].forEach((id) => {
    $(id).disabled = v;
  });
}

function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.className = ok ? "ok" : "err";
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}

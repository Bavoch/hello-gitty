/* Git 操作:暂存/丢弃/提交(AI 流式弹窗)/推送/拉取/GitHub 授权/AI 冲突解决/
   窗口置顶/分支切换 */
import { $, invoke, listen, toast, setBusy, setButtonLoading, runBusy, settings, repo, setLastShipStatus } from "./state.js";
import { refresh, refreshShipButtons } from "./panel.js";

/* ===== 暂存 / 丢弃 ===== */
export async function stageAll(stage) {
  const btn = stage ? $("btn-stage-all") : $("btn-unstage-all");
  // 图标按钮:加载态只显示 spinner,不附加文字(文字会撑破 28px 按钮)
  setButtonLoading(btn, true, "");
  try {
    await invoke(stage ? "git_stage_all" : "git_unstage_all", { repo });
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading(btn, false);
  }
  await refresh();
}

let discardTarget = null; // 丢弃确认:null=丢弃全部更改;路径=丢弃单个文件

export function discardAll() {
  discardTarget = null;
  $("discard-title").textContent = "取消所有修改";
  $("discard-hint").textContent = "将丢弃所有未暂存与已暂存的改动，工作区恢复到上次提交的状态，此操作不可恢复。";
  $("btn-discard-all-confirm").textContent = "确认取消所有修改";
  $("dlg-discard-all").classList.remove("hidden");
}

// 单文件丢弃:复用确认框,标题/文案指向具体文件
export function askDiscardFile(path) {
  discardTarget = path;
  $("discard-title").textContent = "丢弃更改";
  $("discard-hint").textContent = "将丢弃「" + path + "」的未提交更改（未跟踪文件将被删除），此操作不可恢复。";
  $("btn-discard-all-confirm").textContent = "确认丢弃";
  $("dlg-discard-all").classList.remove("hidden");
}

async function doDiscardAll() {
  const btn = $("btn-discard-all");
  $("dlg-discard-all").classList.add("hidden");
  setButtonLoading(btn, true, "");
  const target = discardTarget;
  discardTarget = null;
  try {
    if (target) await invoke("git_discard_file", { repo, path: target });
    else await invoke("git_discard_all", { repo });
    toast(target ? "已丢弃该文件的更改" : "已取消所有修改", true);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading(btn, false);
  }
  await refresh();
}

export async function toggleStage(path, unstage) {
  // 单文件暂存/取消暂存很快,不显示加载提示,静默执行
  try {
    const r = await invoke(unstage ? "git_unstage_file" : "git_stage_file", { repo, path });
    if (r && r.ok === false) toast(r.output, false);
  } catch (e) {
    toast(String(e), false);
  }
  await refresh();
}

/* ===== 提交(AI 流式) ===== */
let popState = "idle";     // 提交弹窗态:streaming(生成中) / ready(可编辑确认) / idle(关闭)
let streamCancelled = false; // 软取消:流式中忽略后续事件、不自动提交
let streamBusy = false;    // 流式 invoke 进行中(含已软取消但后端未返回),用于阻塞重复触发

async function onCommit() {
  if (!repo) { toast("请先打开项目", false); return; }
  // 弹窗已开或流式生成进行中时不重复触发
  if (popState !== "idle" || streamBusy) return;
  // 立即打开弹窗 + 禁用提交按钮,给用户即时反馈(不等 git status/暂存的网络往返)
  openCommitPop();
  try {
    const st = await invoke("git_status", { repo });
    setLastShipStatus(st); // 让 closeCommitPop 恢复按钮时基于最新状态
    const total = st.staged.length + st.unstaged.length + st.untracked.length;
    if (total === 0) { toast("没有可提交的更改", false); closeCommitPop(); return; }
    // 智能提交:有未暂存/未跟踪时先全部暂存,一次性提交完本地所有改动(对标 VS Code)
    if (st.staged.length < total) await invoke("git_stage_all", { repo });
    await streamCommitMessage();
  } catch (e) {
    toast(String(e), false);
    // AI 生成失败时 streamCommitMessage 会把弹窗切到可编辑手填态(popState=ready),保留;
    // 这里只关闭 status/暂存阶段失败留下的空弹窗
    if (popState === "streaming") closeCommitPop();
  }
}

// 打开弹窗:进入生成中态
function openCommitPop() {
  popState = "streaming";
  streamCancelled = false;
  const ta = $("commit-stream-text");
  ta.value = "";
  ta.readOnly = true; // 生成中只读(用 readOnly 而非 disabled,避免文本被强制置灰、看不清流式输出)
  $("commit-pop-title").textContent = "AI 正在生成提交信息…";
  $("commit-pop-spin").classList.remove("hidden");
  $("commit-pop-actions").classList.add("hidden");
  $("commit-pop").classList.remove("hidden");
  // 提交中禁用工具栏按钮,避免重复触发;弹窗关闭时由 closeCommitPop 恢复
  const cb = $("btn-commit");
  if (cb) cb.disabled = true;
}

function closeCommitPop() {
  popState = "idle";
  $("commit-pop").classList.add("hidden");
  refreshShipButtons(); // 恢复提交按钮(openCommitPop 时禁用过)
}

// 弹窗进入可编辑确认态
function readyCommitPopForEdit(msg) {
  const ta = $("commit-stream-text");
  ta.value = msg;
  ta.readOnly = false; // 生成完成,转为可编辑
  ta.focus();
  $("commit-pop-actions").classList.remove("hidden");
  popState = "ready";
}

// 流式生成:边生成边回填;完成后 auto 模式直接提交,confirm 模式进入可编辑态
async function streamCommitMessage() {
  openCommitPop();
  streamBusy = true;
  let msg = "";
  try {
    msg = await invoke("ai_commit_message_stream", { settings: settings.ai, repo });
  } catch (e) {
    if (streamCancelled) return; // 已软取消:静默
    $("commit-pop-spin").classList.add("hidden");
    $("commit-pop-title").textContent = "AI 生成失败，可手动填写：";
    readyCommitPopForEdit("");
    throw e; // 让调用方 toast 具体错误
  } finally {
    streamBusy = false;
  }
  if (streamCancelled) return;
  // 直接提交模式:生成完即提交
  if (settings.ai.commit_mode === "auto") {
    await commitWithMessage(msg);
    return;
  }
  // 确认模式:可编辑 + 操作行
  $("commit-pop-spin").classList.add("hidden");
  $("commit-pop-title").textContent = "AI 已生成，可修改后提交";
  readyCommitPopForEdit(msg);
}

// 取消/关闭:流式中软取消(后端继续、前端忽略),否则直接关
function cancelCommitPop() {
  if (popState === "streaming") streamCancelled = true;
  closeCommitPop();
}

// 用给定信息提交(供 auto 模式与确认按钮复用),成功后刷新并关闭弹窗
async function commitWithMessage(msg) {
  if (popState === "idle") return;
  msg = (msg || "").trim();
  if (!msg) { toast("提交信息不能为空", false); return; }
  popState = "idle"; // 阻塞重复触发
  try {
    const r = await invoke("git_commit", { repo, message: msg });
    if (r && r.ok === false) toast(r.output, false);
    else toast("提交成功", true);
  } catch (e) {
    toast(String(e), false);
  }
  closeCommitPop();
  await refresh();
}

/* ===== 推送 / 拉取 ===== */
// 实际推送(git_push + 授权引导)
export async function doPush() {
  if (!repo) { toast("请先打开项目", false); return; }
  const btn = $("btn-push");
  setButtonLoading(btn, true, "推送中…");
  try {
    const r = await invoke("git_push", { repo });
    toast(r.output, r.ok);
    // 无远程且无凭据:引导浏览器授权
    if (!r.ok && r.output.startsWith("[NEED_AUTH]")) askGithubToken();
  } catch (e) {
    if (String(e).includes("[NEED_AUTH]")) askGithubToken();
    else toast(String(e), false);
  } finally {
    setButtonLoading(btn, false);
  }
}

export async function doPull() {
  if (!repo) { toast("请先打开项目", false); return; }
  const btn = $("btn-pull");
  setButtonLoading(btn, true, "拉取中…");
  try {
    const r = await invoke("git_pull", { repo });
    toast(r.output, r.ok);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading(btn, false);
  }
  await refresh();
  // 冲突只在拉取后提示,由用户决定是否用 AI 自动解决
  checkConflictsAfterPull();
}

/* ===== GitHub 浏览器授权 ===== */
async function askGithubToken() {
  try { await invoke("open_auth_page"); } catch (_) { /* 浏览器打不开也不阻塞弹窗 */ }
  $("set-gh-token").value = "";
  $("dlg-token").classList.remove("hidden");
  $("set-gh-token").focus();
}

async function submitGithubToken() {
  const token = $("set-gh-token").value.trim();
  if (!token) { toast("Token 不能为空", false); return; }
  $("dlg-token").classList.add("hidden");
  setButtonLoading($("btn-token-confirm"), true, "连接中…");
  try {
    const r = await invoke("git_push_with_token", { repo, token });
    if (r && r.ok === false) toast(r.output, false);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-token-confirm"), false);
  }
  await refresh();
}

async function checkConflictsAfterPull() {
  if (!repo) return;
  const st = await invoke("git_status", { repo });
  if (st.conflicts.length > 0) {
    $("merge-conflict-count").textContent = st.conflicts.length;
    $("dlg-merge-conflict").classList.remove("hidden");
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
    let mergedNote = "";
    if (failN === 0) {
      // 全部解决后,若处于合并中则自动完成合并提交
      try {
        const mr = await invoke("git_finish_merge", { repo });
        if (mr && mr.merged) mergedNote = " 已自动完成合并提交";
      } catch (_) { /* 非合并状态或提交失败,保持已暂存状态 */ }
    }
    $("conflict-detail").textContent = failN
      ? `成功 ${okN} 个，失败 ${failN} 个：` + results.filter((r) => !r.ok).map((r) => `\n• ${r.path}： ${r.error}`).join("")
      : `全部 ${okN} 个冲突已由 AI 解决，文件已暂存${mergedNote}。`;
    toast(failN ? `解决 ${okN} 个，${failN} 个失败` : (mergedNote ? "冲突已解决并完成合并" : "冲突已解决"), failN === 0);
  } catch (e) {
    $("conflict-detail").textContent = String(e);
    toast(String(e), false);
  } finally {
    setBusy(false);
    $("btn-conflict-done").disabled = false;
    await refresh();
  }
}

export async function resolveOne(path) {
  await runBusy("ai_resolve_file", { settings: settings.ai, repo, path }, "AI 解决中…", "已解决：" + path);
  await refresh();
}

/* ===== 窗口置顶 ===== */
let pinned = false;
async function togglePin() {
  pinned = !pinned;
  try {
    await invoke("window_set_always_on_top", { on: pinned });
    $("btn-pin").classList.toggle("active", pinned);
    $("btn-pin").title = pinned ? "取消置顶" : "窗口置顶";
    toast(pinned ? "已置顶" : "已取消置顶", true);
  } catch (e) {
    pinned = !pinned; // 失败回滚状态
    toast("置顶失败：" + e, false);
  }
}

/* ===== 分支切换 ===== */
let branchCache = null; // { repo, data } 分支列表缓存:首次查询后直接复用,免去重复加载

// 仓库状态变化时由 refresh 调用,作废分支缓存
export function invalidateBranchCache() {
  branchCache = null;
}

function renderBranchGroups(box, b) {
  box.innerHTML = "";
  const group = (title, items, isRemote) => {
    const g = document.createElement("div");
    g.className = "branch-group";
    const h = document.createElement("div");
    h.className = "branch-group-title";
    h.textContent = title;
    g.appendChild(h);
    if (!items.length) {
      const none = document.createElement("div");
      none.className = "branch-none";
      none.textContent = "无";
      g.appendChild(none);
      return g;
    }
    for (const name of items) {
      const item = document.createElement("button");
      item.className = "branch-item" + (name === b.current ? " current" : "");
      const mark = document.createElement("span");
      mark.className = "branch-mark";
      if (name === b.current) {
        mark.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      } else if (isRemote) {
        mark.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
      }
      const label = document.createElement("span");
      label.className = "branch-label";
      label.textContent = isRemote ? name.replace(/^origin\//, "") : name;
      item.append(mark, label);
      item.addEventListener("click", () => switchBranch(name));
      g.appendChild(item);
    }
    return g;
  };

  box.append(group("本地", b.locals, false));
  box.append(group("远程", b.remotes, true));
  box.classList.remove("hidden");
}

async function openBranchMenu() {
  if (!repo) return;
  const box = $("branch-menu");
  // 已有本仓库缓存:直接渲染,不再显示加载态
  if (branchCache && branchCache.repo === repo) {
    renderBranchGroups(box, branchCache.data);
    return;
  }
  // 首次查询:显示加载占位(居中),完成后缓存
  box.innerHTML = '<div class="branch-loading">加载中…</div>';
  box.classList.remove("hidden");
  const b = await invoke("git_branches", { repo }).catch(() => null);
  if (box.classList.contains("hidden")) return; // 等待期间已被关闭
  if (!b) {
    box.innerHTML = '<div class="branch-loading">加载失败</div>';
    return;
  }
  branchCache = { repo, data: b };
  renderBranchGroups(box, b);
}

async function switchBranch(name) {
  $("branch-menu").classList.add("hidden");
  setButtonLoading($("btn-branch"), true, "切换中…");
  let ok = false;
  try {
    const r = await invoke("git_checkout", { repo, branch: name });
    ok = r && r.ok;
    if (!ok) toast(r.output, false);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-branch"), false);
  }
  await refresh();
  if (ok) toast("已切换到 " + name, true);
}

/* ===== 事件绑定 ===== */
export function bindGitEvents() {
  $("btn-commit").addEventListener("click", () => onCommit());
  $("btn-push").addEventListener("click", async () => { await doPush(); await refresh(); });
  $("btn-pull").addEventListener("click", doPull);
  // 提交流式弹窗按钮
  $("commit-pop-close").addEventListener("click", cancelCommitPop);
  $("commit-pop-cancel").addEventListener("click", cancelCommitPop);
  $("commit-pop-regen").addEventListener("click", () => streamCommitMessage());
  $("commit-pop-ok").addEventListener("click", () => commitWithMessage($("commit-stream-text").value));
  $("btn-branch").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("branch-menu");
    if (menu.classList.contains("hidden")) openBranchMenu();
    else menu.classList.add("hidden");
  });
  $("branch-menu").addEventListener("click", (e) => e.stopPropagation());
  $("btn-ai-resolve").addEventListener("click", resolveAllConflicts);
  $("btn-pin").addEventListener("click", togglePin);
  $("btn-token-cancel").addEventListener("click", () => $("dlg-token").classList.add("hidden"));
  $("btn-token-confirm").addEventListener("click", submitGithubToken);
  $("btn-discard-all-cancel").addEventListener("click", () => $("dlg-discard-all").classList.add("hidden"));
  $("btn-discard-all-confirm").addEventListener("click", doDiscardAll);
  $("btn-merge-ai").addEventListener("click", () => {
    $("dlg-merge-conflict").classList.add("hidden");
    resolveAllConflicts();
  });
  $("btn-merge-manual").addEventListener("click", () => $("dlg-merge-conflict").classList.add("hidden"));
  $("btn-conflict-done").addEventListener("click", () => $("dlg-conflict").classList.add("hidden"));
}

/* ===== 后端事件监听 ===== */
export function initGitListeners() {
  listen("conflict-progress", (e) => {
    const p = e.payload;
    $("conflict-current").textContent = `(${p.done}/${p.total}) ${p.path}`;
    $("conflict-fill").style.width = `${Math.round((p.done / p.total) * 100)}%`;
  });
  // 提交信息流式回填:弹窗打开且未软取消时,用后端推送的累积全文整体写入文本框
  listen("commit-stream", (e) => {
    if (popState === "idle" || streamCancelled) return;
    const ta = $("commit-stream-text");
    ta.value = e.payload.text;
    ta.scrollTop = ta.scrollHeight; // 流式输出自动滚到底部,始终展示最新生成内容
  });
}

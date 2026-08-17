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
  $("discard-hint").textContent = "将丢弃所有已暂存和未暂存的改动，并删除未跟踪文件，恢复到上次提交的状态。此操作不可恢复。";
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

// 直接丢弃单个文件(右侧列表两步确认的第二步),不走对话框
export async function discardFile(path) {
  try {
    const r = await invoke("git_discard_file", { repo, path });
    if (r && r.ok === false) toast(r.output, false);
    else toast("已丢弃该文件的更改", true);
  } catch (e) {
    toast(String(e), false);
  }
  await refresh();
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
// 每个项目独立的面板状态:repo -> {state, msg, cancelled, busy}
// 面板完全跟随项目:在 A 打开的面板不受 B 的任何操作影响,切走隐藏、切回恢复
const commitPops = new Map();
function popOf(repoPath) {
  if (!repoPath) return null;
  let p = commitPops.get(repoPath);
  if (!p) { p = { state: "idle", msg: "", cancelled: false, busy: false }; commitPops.set(repoPath, p); }
  return p;
}

async function onCommit() {
  if (!repo) { toast("请先打开项目", false); return; }
  const p = popOf(repo);
  // 当前项目已有面板(生成中或待确认)时防重入
  if (p.state !== "idle" || p.busy) return;
  try {
    const st = await invoke("git_status", { repo });
    setLastShipStatus(st); // 让 closeCommitPop 恢复按钮时基于最新状态
    // 只提交暂存区:暂存区为空时说明原因(有未暂存改动→引导暂存;完全干净→无可提交)
    if (st.staged.length === 0) {
      toast(st.unstaged.length + st.untracked.length > 0
        ? "没有已暂存的更改，请先暂存"
        : "没有可提交的更改", false);
      return;
    }
    // 未配置 AI Key:直接进入手动填写面板,跳过 AI 调用(不再绕"AI 失败"的错误流程)
    if (!(settings.ai.api_key || "").trim()) {
      toast("未配置 AI API Key，可手动填写提交信息", false);
      showCommitResult(p, "", "手动填写提交信息");
      return;
    }
    await streamCommitMessage(p);
  } catch (e) {
    toast(String(e), false);
    // AI 生成失败时 streamCommitMessage 会把面板切到可编辑手填态,保留;
    // 这里只关闭 status 阶段失败留下的空面板
    if (p.state === "streaming") closeCommitPop(p);
  }
}

// 开始生成:仅提交按钮转加载态,不弹窗(结果面板等生成完成后才出现)
function startCommitStreaming(p) {
  p.state = "streaming";
  p.cancelled = false;
  setButtonLoading($("btn-commit"), true, "AI 生成评论中…");
}

// 生成完成:弹出结果面板,输入框可编辑,供用户确认/修改后提交或取消
function showCommitResult(p, msg, ph) {
  p.state = "ready";
  p.msg = msg;
  const ta = $("commit-stream-text");
  ta.value = msg;
  ta.readOnly = false;
  ta.placeholder = ph || "AI 已生成，可修改后提交";
  $("commit-pop").classList.remove("hidden");
  // 提交按钮退出加载态;面板打开期间保持禁用防重复触发
  const cb = $("btn-commit");
  if (cb) { setButtonLoading(cb, false); cb.disabled = true; }
  ta.setSelectionRange(0, 0); // 光标置于开头,避免聚焦后自动滚到结尾
  ta.focus();
  ta.scrollTop = 0; // 展示从开头开始(聚焦可能把光标滚入视野,故在其后归零)
}

function closeCommitPop(p) {
  p.state = "idle";
  p.msg = "";
  $("commit-pop").classList.add("hidden");
  const cb = $("btn-commit");
  if (cb) { setButtonLoading(cb, false); cb.disabled = false; } // 退出加载态并解锁
  refreshShipButtons(); // 按当前仓库状态重建按钮样式/提示
}

// 项目切换时同步面板显隐:面板跟随所属项目——切走隐藏,切回恢复
// 切走时先把当前输入框内容存回该项目状态,切回时从状态恢复
export function syncCommitPop() {
  const p = popOf(repo);
  if (p.state === "idle") { $("commit-pop").classList.add("hidden"); return; }
  // 恢复本项目面板
  const ta = $("commit-stream-text");
  ta.value = p.msg;
  ta.readOnly = p.state === "ready";
  ta.scrollTop = 0; // 恢复面板同样从开头展示
  $("commit-pop").classList.remove("hidden");
  // 按钮态:ready 保持禁用(面板打开中);streaming 保持加载态
  const cb = $("btn-commit");
  if (cb) {
    if (p.state === "ready") { setButtonLoading(cb, false); cb.disabled = true; }
    else { setButtonLoading(cb, true, "AI 生成评论中…"); }
  }
}

// 流式生成:生成期间按钮加载态,完成后弹出结果面板;失败也弹出可手填面板
async function streamCommitMessage(p) {
  const repoPath = repo; // 记录发起项目:await 期间用户可能已切换项目
  startCommitStreaming(p);
  p.busy = true;
  let msg = "";
  try {
    msg = await invoke("ai_commit_message_stream", { settings: settings.ai, repo: repoPath });
  } catch (e) {
    if (p.cancelled) return; // 已软取消:静默
    showCommitResult(p, "", "AI 生成失败，可手动填写后提交");
    throw e; // 让调用方 toast 具体错误
  } finally {
    p.busy = false;
  }
  if (p.cancelled) return;
  // 已切到其他项目:不弹面板也不自动提交,保留 ready 态等切回时由 syncCommitPop 恢复
  if (repo !== repoPath) { p.state = "ready"; p.msg = msg; return; }
  // 直接提交模式:生成完即提交,不弹确认面板;AI 未返回内容时仍落回面板手填
  // (commitWithMessage 对空消息只 toast 不复位状态,不能让按钮卡在加载态)
  if ((settings.ai.commit_mode || "auto") === "auto" && msg.trim()) {
    await commitWithMessage(msg);
    return;
  }
  showCommitResult(p, msg, msg.trim() ? undefined : "AI 未返回内容，可手动填写后提交");
}

// 取消/关闭:流式中软取消(后端继续、前端忽略),否则直接关
function cancelCommitPop() {
  const p = popOf(repo);
  if (p.state === "streaming") p.cancelled = true;
  closeCommitPop(p);
}

// 用给定信息提交(供 auto 模式与确认按钮复用),成功后刷新并关闭弹窗
async function commitWithMessage(msg) {
  const p = popOf(repo);
  if (p.state === "idle") return;
  msg = (msg || "").trim();
  if (!msg) { toast("提交信息不能为空", false); return; }
  p.state = "idle"; // 阻塞重复触发
  try {
    const r = await invoke("git_commit", { repo, message: msg });
    if (r && r.ok === false) toast(r.output, false);
    else toast("提交成功", true);
  } catch (e) {
    toast(String(e), false);
  }
  closeCommitPop(p);
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
  // 提交结果面板:取消 = 关闭面板;提交 = 用当前内容提交;Esc 取消;回车提交(Shift+Enter 换行)
  $("btn-commit-cancel").addEventListener("click", cancelCommitPop);
  $("btn-commit-confirm").addEventListener("click", () => commitWithMessage($("commit-stream-text").value));
  $("commit-stream-text").addEventListener("keydown", (e) => {
    const p = popOf(repo);
    if (p.state === "idle") return;
    if (e.key === "Escape") { e.preventDefault(); cancelCommitPop(); }
    else if (e.key === "Enter" && !e.isComposing && !e.shiftKey && p.state === "ready") {
      e.preventDefault();
      commitWithMessage($("commit-stream-text").value);
    }
  });
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
  // 提交信息流式回填:按事件携带的 repo 路由到该项目状态;
  // 仅当该项目的流未软取消时,把累积全文写入当前输入框(若正显示该项目面板)
  listen("commit-stream", (e) => {
    const p = popOf(e.payload?.repo);
    if (!p || p.state !== "streaming" || p.cancelled) return;
    if (e.payload?.repo !== repo) return; // 面板所属项目不是当前项目时不写输入框
    const ta = $("commit-stream-text");
    ta.value = e.payload.text;
    ta.scrollTop = ta.scrollHeight; // 流式输出自动滚到底部,始终展示最新生成内容
  });
}

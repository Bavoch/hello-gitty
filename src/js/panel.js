/* 仓库面板视图:刷新主区(状态+历史)、空态、文件列表(暂存/更改/冲突)、diff 视图、
   忽略规则对话框、「更多」菜单 */
import { $, invoke, toast, setButtonLoading, STATUS_CHARS, repo, lastShipStatus, setLastShipStatus } from "./state.js";
import { updateSidebarCurrent, updateProjectHeader, loadRepos, fetchRemote, removeRepo } from "./sidebar.js";
import { renderHistory } from "./history.js";
import { toggleStage, askDiscardFile, resolveOne, stageAll, discardAll, invalidateBranchCache } from "./git-ops.js";

const sectionUserSet = new Set(); // 用户手动切换过的分组:自动收起规则不再覆盖其状态

/* ===== 主区刷新 ===== */
export async function refresh() {
  if (!repo) return;
  invalidateBranchCache(); // 仓库状态已变(切分支/推送/拉取等),分支缓存作废
  updateProjectHeader(); // 顶部标题栏:当前项目图标 + 名称
  // 一次拉取合并的 status + history(后端复用 status 的 branch 信息,省去重复 git 进程)
  const data = await invoke("git_refresh", { repo });
  const st = data.status, hist = data.history;
  if (!st.is_repo) {
    showEmpty(true);
    updateSidebarCurrent(st);
    return;
  }
  showPanel(st);
  renderHistory(hist, st.branch, data.checkpoints);
  updateSidebarCurrent(st); // 侧栏只就地更新当前项,不做全量扫描
}

// 切换仓库的加载占位:延迟 150ms 显示(毫秒级切换不闪 spinner),一旦显示至少停留 250ms(避免抖一下)
let refreshingTimer = null;
let refreshingShownAt = 0;
const REFRESH_DELAY_MS = 150;
const REFRESH_MIN_MS = 250;

export function showRefreshing() {
  clearTimeout(refreshingTimer);
  refreshingTimer = setTimeout(() => {
    refreshingShownAt = Date.now();
    $("empty-state").classList.add("hidden");
    $("panel").classList.add("hidden");
    $("refreshing-state").classList.remove("hidden");
  }, REFRESH_DELAY_MS);
}

// 藏起占位:从未显示则直接返回;显示不足最短时长则延后,resolve 时占位已彻底隐藏
function hideRefreshing() {
  clearTimeout(refreshingTimer);
  const el = $("refreshing-state");
  if (el.classList.contains("hidden")) return Promise.resolve();
  const wait = REFRESH_MIN_MS - (Date.now() - refreshingShownAt);
  if (wait <= 0) { el.classList.add("hidden"); return Promise.resolve(); }
  return new Promise((resolve) => setTimeout(() => { el.classList.add("hidden"); resolve(); }, wait));
}

export async function showEmpty(showInit) {
  const { leaveOverview } = await import("./dashboard.js");
  leaveOverview();
  // 无项目时隐藏标题栏;当前选中项不是 Git 仓库时仍保留(项目已选定)
  $("project-header").classList.toggle("hidden", !repo);
  $("panel").classList.add("hidden");
  await hideRefreshing();
  $("empty-state").classList.remove("hidden");
  if (showInit) {
    // 当前选中的不是 Git 仓库:简洁提示 + 仅保留初始化入口
    $("empty-title").textContent = "不是 Git 仓库";
    $("empty-desc").textContent = "此文件夹尚未初始化为 Git 仓库";
    $("btn-init").classList.remove("hidden");
    $("btn-open2").classList.add("hidden");
    $("btn-clone").classList.add("hidden");
  } else {
    // 尚未打开任何仓库
    $("empty-title").textContent = "打开一个项目";
    $("empty-desc").textContent = "选择本地文件夹，或从远程仓库克隆";
    $("btn-init").classList.add("hidden");
    $("btn-open2").classList.remove("hidden");
    $("btn-clone").classList.remove("hidden");
  }
  $("branch-name").textContent = "—";
  $("branch-name").title = "";
  // 无仓库:提交/推送/拉取按钮复位为次要态(不禁用,点击有 toast 提示)
  setLastShipStatus(null);
  for (const id of ["btn-commit", "btn-push", "btn-pull"]) {
    const b = $(id);
    if (b) b.classList.remove("primary");
  }
  if ($("push-count")) $("push-count").className = "btn-count hidden";
  if ($("pull-count")) $("pull-count").classList.add("hidden");
}

export async function showPanel(st) {
  $("empty-state").classList.add("hidden");
  await hideRefreshing();
  $("panel").classList.remove("hidden");

  renderList("conflict-list", st.conflicts, "conflict", $("conflict-count"));
  renderList("staged-list", st.staged, "staged", $("staged-count"));
  renderList("unstaged-list", [...st.unstaged, ...st.untracked], "unstaged", $("unstaged-count"));

  // 列表为空时禁用对应整组操作按钮:取消全部暂存←暂存数;取消修改/全部暂存←更改数
  $("btn-unstage-all").disabled = st.staged.length === 0;
  $("btn-discard-all").disabled = st.unstaged.length + st.untracked.length === 0;
  $("btn-stage-all").disabled = st.unstaged.length + st.untracked.length === 0;

  $("sec-conflicts").classList.toggle("hidden", st.conflicts.length === 0);
  $("btn-ai-resolve").disabled = st.conflicts.length === 0;
  // 分组默认展开/收起:历史始终收起;暂存/更改按是否有内容决定。
  // 仅作为默认展示规则——用户手动切换过的分组保持其状态,刷新不覆盖。
  if (!sectionUserSet.has("sec-staged")) setSectionOpen("sec-staged", "staged-list", st.staged.length > 0);
  if (!sectionUserSet.has("sec-unstaged")) setSectionOpen("sec-unstaged", "unstaged-list", st.unstaged.length + st.untracked.length > 0);
  if (!sectionUserSet.has("sec-history")) setSectionOpen("sec-history", "history-container", false);
  // 右侧面板显示当前分支
  $("branch-name").textContent = st.detached ? "（分离）" : (st.branch || "（无分支）");
  $("branch-name").title = st.branch || "";
  setLastShipStatus(st);
  setCommitButton(st);
  setPushButton(st);
  // 拉取按钮同规则:有落后 → 主按钮样式;已同步 → 正常次要样式(永不禁用,点击有 toast 提示)
  const pb = $("btn-pull"), lc = $("pull-count");
  if (pb && !pb.classList.contains("loading")) {
    const dirty = st.behind > 0;
    pb.disabled = false;
    pb.title = dirty ? "拉取远程新提交" : "没有可拉取的提交";
    pb.classList.toggle("primary", dirty);
  }
  if (lc) {
    lc.classList.toggle("hidden", !(st.behind > 0));
    if (st.behind > 0) lc.textContent = st.behind;
  }
}

// 设置分组展开/收起(open=true 展开):同步 .collapsed 与目标列表显隐
function setSectionOpen(secId, targetId, open) {
  $(secId).classList.toggle("collapsed", !open);
  $(targetId).classList.toggle("hidden", !open);
}

// 提交按钮:有任何本地更改 → 主按钮样式;干净 → 正常次要样式(永不禁用,空操作走 toast)
function setCommitButton(st) {
  const btn = $("btn-commit");
  if (!btn || btn.classList.contains("loading")) return; // loading 中不重建,避免打断操作
  const pending = st.staged.length + st.unstaged.length + st.untracked.length;
  btn.disabled = false;
  btn.title = pending > 0 ? "提交全部本地更改" : "没有可提交的更改";
  btn.classList.toggle("primary", pending > 0);
}

// 推送按钮:本地领先 → 主按钮样式;无领先 → 正常次要样式(永不禁用,空操作走 toast)
function setPushButton(st) {
  const btn = $("btn-push");
  if (!btn || btn.classList.contains("loading")) return;
  const count = $("push-count");
  const dirty = st.ahead > 0;
  btn.disabled = false;
  btn.title = dirty ? "推送本地领先的提交" : "没有待推送的提交";
  btn.classList.toggle("primary", dirty);
  if (count) {
    count.classList.toggle("hidden", !dirty);
    if (dirty) count.textContent = st.ahead;
  }
}

// 操作完成后的 loading 复位会还原按钮旧 DOM,这里按最新状态重建,避免显示态错乱
export function refreshShipButtons() {
  if (lastShipStatus) {
    setCommitButton(lastShipStatus);
    setPushButton(lastShipStatus);
  }
}

/* ===== 文件列表 ===== */
function renderList(listId, entries, kind, countEl) {
  const ul = $(listId);
  ul.innerHTML = "";
  countEl.textContent = entries.length;
  countEl.classList.toggle("badge", entries.length > 0); // 有改动时用蓝色胶囊标签,为 0 回落简洁灰数字
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "file-row" + (kind === "conflict" ? " conflict" : "");

    // 仅冲突列表保留状态字母徽标;暂存/更改列表不显示
    if (kind === "conflict") {
      const st = document.createElement("span");
      st.className = "st st-" + stChar(e, kind);
      st.textContent = stChar(e, kind);
      li.appendChild(st);
    }

    const path = document.createElement("span");
    path.className = "path";
    path.textContent = e.orig_path ? `${e.path} → ${e.orig_path}` : e.path;
    path.title = e.path;
    li.appendChild(path);

    // 增删行数(仅暂存/更改;无变动不显示),增=绿、删=红
    if (kind !== "conflict" && (e.added > 0 || e.deleted > 0)) {
      const stat = document.createElement("span");
      stat.className = "lines";
      const a = document.createElement("span"); a.className = "add"; a.textContent = "+" + e.added;
      const d = document.createElement("span"); d.className = "del"; d.textContent = "-" + e.deleted;
      stat.append(a, d);
      li.appendChild(stat);
    }

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
      const ig = document.createElement("button");
      ig.textContent = "忽略";
      ig.addEventListener("click", (ev) => { ev.stopPropagation(); askIgnore(e.path); });
      actions.appendChild(ig);
      // 仅未暂存/未跟踪行提供「丢弃」(已跟踪→还原,未跟踪→删除)
      if (kind === "unstaged") {
        const di = document.createElement("button");
        di.textContent = "丢弃";
        di.addEventListener("click", (ev) => { ev.stopPropagation(); askDiscardFile(e.path); });
        actions.appendChild(di);
      }
    }
    li.appendChild(actions);

    li.addEventListener("click", () => {
      if (kind === "conflict") resolveOne(e.path);
      else showDiff(e, kind);
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

// 添加到 .gitignore:计算文件名/扩展名/目录候选规则
function askIgnore(path) {
  $("dlg-ignore").dataset.path = path;
  const base = path.split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? "*" + base.slice(dot) : null;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : null;
  $("ignore-file-name").textContent = "文件： " + path;
  const box = $("ignore-options");
  box.innerHTML = "";
  const opts = [{ label: "此文件", rule: base }];
  if (ext) opts.push({ label: "此扩展名", rule: ext });
  if (dir) opts.push({ label: "此目录", rule: dir });
  opts.forEach((o, i) => {
    const lab = document.createElement("label");
    lab.className = "ignore-opt";
    const r = document.createElement("input");
    r.type = "checkbox"; r.value = o.rule;
    if (i === 0) r.checked = true;
    const code = document.createElement("code");
    code.textContent = o.rule;
    lab.append(r, document.createTextNode(" " + o.label + " "), code);
    box.appendChild(lab);
  });
  $("dlg-ignore").classList.remove("hidden");
}

// 打开 diff 视图:整行点击查看差异
async function showDiff(e, kind) {
  $("diff-title").textContent = e.path;
  $("diff-content").innerHTML = '<span class="d-load">加载中…</span>';
  $("dlg-diff").classList.remove("hidden");
  try {
    const diff = await invoke("git_diff", { repo, path: e.path, staged: kind === "staged" });
    $("diff-content").innerHTML = diff ? renderDiff(diff) : '<span class="d-empty">无差异内容</span>';
  } catch (err) {
    $("diff-content").innerHTML = '<span class="d-empty">' + String(err) + "</span>";
  }
}

// diff 渲染(VS Code 风格:行级背景 + gutter + / -)
function renderDiff(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split("\n").map((line) => {
    let cls = "d-ctx", sign = " ", body = line;
    if (line.startsWith("+++") || line.startsWith("---")) cls = "d-meta";
    else if (line.startsWith("+")) { cls = "d-add"; sign = "+"; body = line.slice(1); }
    else if (line.startsWith("-")) { cls = "d-del"; sign = "-"; body = line.slice(1); }
    else if (line.startsWith("@@")) cls = "d-hunk";
    return `<div class="d-row ${cls}"><span class="d-gutter">${sign}</span><span class="d-text">${esc(body)}</span></div>`;
  }).join("");
}

/* ===== 事件绑定 ===== */
export function bindPanelEvents() {
  $("btn-diff-close").addEventListener("click", () => $("dlg-diff").classList.add("hidden"));
  $("btn-stage-all").addEventListener("click", () => stageAll(true));
  $("btn-unstage-all").addEventListener("click", () => stageAll(false));
  $("btn-discard-all").addEventListener("click", discardAll);

  // 更多菜单
  $("btn-more").addEventListener("click", (e) => {
    e.stopPropagation();
    $("more-menu").classList.toggle("hidden");
  });
  $("btn-more-refresh").addEventListener("click", async () => {
    $("more-menu").classList.add("hidden");
    // 手动刷新:全量重扫所有仓库状态 + 刷新当前面板
    setButtonLoading($("btn-more"), true, "刷新中…");
    try {
      fetchRemote(); // 手动刷新:同时后台核对远程状态
      await loadRepos();
      await refresh();
    } finally {
      setButtonLoading($("btn-more"), false);
    }
  });
  $("btn-more-remove").addEventListener("click", () => {
    $("more-menu").classList.add("hidden");
    if (repo) removeRepo(repo);
  });
  $("btn-more-gitignore").addEventListener("click", async () => {
    $("more-menu").classList.add("hidden");
    if (!repo) return;
    try {
      $("gitignore-content").value = await invoke("gitignore_read", { repo });
    } catch (e) { toast(String(e), false); return; }
    $("dlg-gitignore").classList.remove("hidden");
  });
  $("btn-gitignore-save").addEventListener("click", async () => {
    setButtonLoading($("btn-gitignore-save"), true, "保存中…");
    try {
      await invoke("gitignore_write", { repo, content: $("gitignore-content").value });
      $("dlg-gitignore").classList.add("hidden");
      toast("已保存 .gitignore", true);
      await refresh();
    } catch (e) { toast(String(e), false); }
    finally { setButtonLoading($("btn-gitignore-save"), false); }
  });
  $("btn-gitignore-cancel").addEventListener("click", () => $("dlg-gitignore").classList.add("hidden"));
  $("btn-ignore-confirm").addEventListener("click", async () => {
    const rules = [...document.querySelectorAll("#ignore-options input:checked")].map((r) => r.value);
    if (!rules.length) return;
    setButtonLoading($("btn-ignore-confirm"), true, "添加中…");
    try {
      const content = (await invoke("gitignore_read", { repo })) || "";
      const existing = new Set(content.split("\n").map((l) => l.trim()).filter(Boolean));
      const add = rules.filter((r) => !existing.has(r.trim()));
      const base = content.replace(/\n+$/, "");
      const merged = base + (base && add.length ? "\n" : "") + (add.length ? add.join("\n") + "\n" : "");
      await invoke("gitignore_write", { repo, content: merged });
      // 让被忽略文件立即从列表消失:已跟踪/已暂存文件仅靠 .gitignore 不会从 git status 消失,
      // 需先从 index 移除;未跟踪文件则由 .gitignore 直接隐藏(--ignore-unmatch 对未跟踪文件不报错)
      const ipath = $("dlg-ignore").dataset.path;
      if (ipath) {
        try { await invoke("git_untrack_file", { repo, path: ipath }); } catch (_) {}
      }
      $("dlg-ignore").classList.add("hidden");
      toast(add.length ? "已添加到 .gitignore： " + add.join("、") : "所选规则已存在，无需添加", add.length > 0);
      await refresh();
    } catch (e) { toast(String(e), false); }
    finally { setButtonLoading($("btn-ignore-confirm"), false); }
  });
  $("btn-ignore-cancel").addEventListener("click", () => $("dlg-ignore").classList.add("hidden"));

  document.querySelectorAll(".section-head").forEach((h) =>
    h.addEventListener("click", () => {
      const sec = h.closest(".section");
      sectionUserSet.add(sec.id); // 用户手动改过:后续刷新不再套用默认收起规则
      sec.classList.toggle("collapsed");
      $(h.dataset.target).classList.toggle("hidden");
    })
  );
}

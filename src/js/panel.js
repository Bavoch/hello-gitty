/* 仓库面板视图:刷新主区(状态+历史)、空态、文件列表(暂存/更改/冲突)、diff 视图、
   忽略规则对话框、「更多」菜单 */
import { $, invoke, toast, setButtonLoading, STATUS_CHARS, repo, view, repos, lastShipStatus, setLastShipStatus, setNumBadge } from "./state.js";
import { updateProjectHeader, renderRepoList, removeRepo } from "./sidebar.js";
import { renderHistory } from "./history.js";
import { toggleStage, discardFile, resolveOne, stageAll, discardAll, invalidateBranchCache } from "./git-ops.js";

const sectionUserSet = new Set(); // 用户手动切换过的分组:自动收起规则不再覆盖其状态

/* ===== 主区刷新 ===== */
export async function refresh() {
  if (!repo) return;
  const targetRepo = repo;
  invalidateBranchCache(); // 仓库状态已变(切分支/推送/拉取等),分支缓存作废
  updateProjectHeader(); // 顶部标题栏:当前项目图标 + 名称
  // 一次拉取合并的 status + history(后端复用 status 的 branch 信息,省去重复 git 进程)
  const data = await invoke("git_refresh", { repo: targetRepo });
  // 总览/切换项目期间,旧请求返回的数据不能重新显示项目级工具栏和面板
  if (view !== "repo" || repo !== targetRepo) return;
  const st = data.status, hist = data.history;
  // 就地同步侧栏摘要:角标(未暂存+未跟踪+冲突)/领先落后数/最近提交时间随面板操作即时更新,
  // 不必等全量重扫(暂存一批更改后左侧数字立刻变化);字段口径与后端 summarize 一致
  const sum = repos.find((r) => r.path === targetRepo);
  if (sum) {
    sum.branch = st.branch || null;
    sum.ahead = st.ahead;
    sum.behind = st.behind;
    sum.staged = st.staged.length;
    sum.unstaged = st.unstaged.length + st.untracked.length;
    sum.conflicts = st.conflicts.length;
    sum.is_repo = st.is_repo;
    const head = hist && hist[0];
    if (head && head.timestamp) sum.last_commit_ts = head.timestamp;
    renderRepoList();
  }
  if (!st.is_repo) {
    showEmpty(true);
    return;
  }
  showPanel(st);
  renderHistory(hist, st.branch);
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
  $("toolbar").classList.add("hidden"); // 空态无 Git 操作,隐藏顶部工具栏
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
  if ($("push-count")) {
    setNumBadge($("push-count"), 0);
    $("push-count").classList.add("hidden");
  }
  if ($("pull-count")) $("pull-count").classList.add("hidden");
}

export async function showPanel(st) {
  $("empty-state").classList.add("hidden");
  $("toolbar").classList.remove("hidden"); // 仓库面板恢复顶部工具栏
  await hideRefreshing();
  $("panel").classList.remove("hidden");

  renderList("conflict-list", st.conflicts, "conflict", $("conflict-count"));
  // 暂存计数弱化显示:灰字无胶囊(暂存是中间态,提示强度低于实际更改)
  renderList("staged-list", st.staged, "staged", $("staged-count"), "dim");
  renderList("unstaged-list", [...st.unstaged, ...st.untracked], "unstaged", $("unstaged-count"));

  // 列表为空时禁用对应整组操作按钮:取消全部暂存←暂存数;取消修改←全部本地改动;全部暂存←未暂存改动
  $("btn-unstage-all").disabled = st.staged.length === 0;
  $("btn-discard-all").disabled = st.staged.length + st.unstaged.length + st.untracked.length === 0;
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
    if (st.behind > 0) { setNumBadge(lc, st.behind, "red"); lc.classList.remove("hidden"); }
    else lc.classList.add("hidden");
  }
}

// 设置分组展开/收起(open=true 展开):同步 .collapsed 与目标列表显隐
function setSectionOpen(secId, targetId, open) {
  $(secId).classList.toggle("collapsed", !open);
  $(targetId).classList.toggle("hidden", !open);
}

// 提交按钮:有已暂存更改 → 主按钮样式;未暂存/干净 → 正常次要样式(永不禁用,空操作走 toast)
function setCommitButton(st) {
  const btn = $("btn-commit");
  if (!btn || btn.classList.contains("loading")) return; // loading 中不重建,避免打断操作
  const pending = st.staged.length + st.unstaged.length + st.untracked.length;
  btn.disabled = false;
  btn.title = st.staged.length > 0 ? "提交已暂存的更改"
    : (pending > 0 ? "请先暂存更改" : "没有可提交的更改");
  btn.classList.toggle("primary", st.staged.length > 0);
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
    if (dirty) { setNumBadge(count, st.ahead); count.classList.remove("hidden"); }
    else count.classList.add("hidden");
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
// mods:数值 >0 时附加的修饰类(如 "dim" 弱化);zero:数值为 0 时的回落形态
function renderList(listId, entries, kind, countEl, mods = "") {
  const ul = $(listId);
  ul.innerHTML = "";
  setNumBadge(countEl, entries.length, mods);
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
      // 仅未暂存/未跟踪行提供「丢弃」(已跟踪→还原,未跟踪→删除)。
      // 两步确认:第一次点击变「✓」待确认态,再点一次才丢弃;悬停离开自动复位
      if (kind === "unstaged") {
        const di = document.createElement("button");
        di.textContent = "丢弃";
        let armed = false;
        let resetTimer = null;
        const reset = () => {
          if (!armed) return;
          armed = false;
          di.textContent = "丢弃";
          di.classList.remove("armed");
        };
        // 移开后延迟复位,给用户留出点击确认的时间
        const scheduleReset = () => {
          if (!armed) return;
          clearTimeout(resetTimer);
          resetTimer = setTimeout(reset, 3000);
        };
        di.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!armed) {
            armed = true; di.textContent = "✓"; di.classList.add("armed");
            clearTimeout(resetTimer);
            return;
          }
          clearTimeout(resetTimer);
          reset();
          discardFile(e.path);
        });
        di.addEventListener("mouseleave", scheduleReset);
        di.addEventListener("mouseenter", () => clearTimeout(resetTimer));
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
  const base = path.split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? "*" + base.slice(dot) : null;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : null;
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
    r.className = "ig-check";
    if (i === 0) r.checked = true;
    const name = document.createElement("span");
    name.className = "ig-name";
    name.textContent = o.label;
    const code = document.createElement("code");
    code.className = "ig-rule";
    code.textContent = o.rule;
    lab.append(r, name, code);
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

// diff 渲染:只展示实际改动内容,滤掉 git diff 的元信息行
// (diff --git / index / --- / +++ / @@ 均为定位或文件头信息,标题已含文件名,省略以保持简洁)
function renderDiff(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split("\n").map((line) => {
    if (line.startsWith("diff --git ") || line.startsWith("index ")
      || line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) return "";
    let cls = "d-ctx", sign = " ", body = line;
    if (line.startsWith("+")) { cls = "d-add"; sign = "+"; body = line.slice(1); }
    else if (line.startsWith("-")) { cls = "d-del"; sign = "-"; body = line.slice(1); }
    return `<div class="d-row ${cls}"><span class="d-gutter">${sign}</span><span class="d-text">${esc(body)}</span></div>`;
  }).join("");
}

// 规范化 .gitignore 排版:注释段落前空一行(跟在规则行后时)、连续空行合一、
// 去行尾空白、统一以单个换行结尾。只动空白,不改动注释与规则的内容和顺序。
function normalizeGitignore(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\s+$/, ""); // 去行尾空白
    const prev = out[out.length - 1];
    const isComment = l.trimStart().startsWith("#");
    if (isComment && prev !== undefined && prev.trim() !== "" && !prev.trimStart().startsWith("#")) {
      out.push(""); // 规则行后直接跟注释:空行分组
    }
    if (l.trim() === "" && (prev === undefined || prev.trim() === "")) continue; // 开头/连续空行
    out.push(l);
  }
  const joined = out.join("\n").replace(/\s+$/, "");
  return joined ? joined + "\n" : "";
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
      await invoke("gitignore_write", { repo, content: normalizeGitignore($("gitignore-content").value) });
      // 同忽略弹窗:新规则命中的已跟踪文件立即移出跟踪,列表即时生效
      try { await invoke("git_untrack_ignored", { repo }); } catch (_) {}
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
      // 去重比较用归一化形式:目录规则的尾斜杠不参与(dist 与 dist/ 对 git 等价,避免重复追加)
      const norm = (s) => s.trim().replace(/\/+$/, "");
      const existing = new Set(content.split("\n").map(norm).filter(Boolean));
      const add = rules.filter((r) => !existing.has(norm(r)));
      if (add.length) {
        const base = normalizeGitignore(content); // 顺带整理既有排版(段落空行统一)
        // 与已有内容空行分隔,避免粘进别人的注释/分组;
        // 尾部已是空行隔开的独立非注释规则块(上次弹窗追加的)则直接续接,不产生碎块
        const tailIsRuleBlock = /\n\s*\n(?!#)[^\n]*$/.test("\n" + base);
        const sep = base ? (tailIsRuleBlock ? "\n" : "\n\n") : "";
        await invoke("gitignore_write", { repo, content: base + sep + add.join("\n") + "\n" });
      }
      // 让被忽略文件立即从列表消失:.gitignore 对已跟踪/已暂存文件不生效,
      // 需把命中规则的所有文件(含同目录/同扩展名的其他文件)移出 git 跟踪
      try { await invoke("git_untrack_ignored", { repo }); } catch (_) {}
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

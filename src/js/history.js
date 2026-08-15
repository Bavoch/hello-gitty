/* 历史时间线:本地/远程提交合并展示、存档点混排、强制回退、存档点创建/读档/删除 */
import { $, invoke, toast, setButtonLoading, relTime, relTimeShort, repo } from "./state.js";
import { refresh } from "./panel.js";

export function renderHistory(h, branch, checkpoints) {
  const box = $("history-container");
  box.innerHTML = "";
  // 本地 + 远程按 hash 去重合并,按时间倒序(VS Code 风格单列时间线)
  const remote = h.remote ? h.remote.commits : [];
  const commits = mergeCommits(h.commits, remote);
  // 存档点与提交按时间混排,让用户直观看到存档点落在历史的哪个位置
  const all = [
    ...commits.map((c) => ({ kind: "commit", c })),
    ...(checkpoints || []).map((cp) => ({ kind: "checkpoint", cp })),
  ].sort((a, b) => tsOf(b) - tsOf(a));
  // 计数只算提交(存档点不是版本)
  $("history-count").textContent = commits.length;
  if (!all.length) {
    const none = document.createElement("div");
    none.className = "history-none";
    none.textContent = "暂无提交";
    box.appendChild(none);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "history-list";
  for (const item of all) {
    ul.appendChild(item.kind === "checkpoint" ? checkpointRow(item.cp) : commitRow(item.c, h.head));
  }
  box.appendChild(ul);
}

// 混排条目的时间戳(commit 或 checkpoint)
function tsOf(item) {
  return item.kind === "checkpoint" ? item.cp.timestamp : item.c.timestamp;
}

// 单个提交行:圆点 + hash + message + 作者·时间 + 回退
function commitRow(c, headHash) {
  const li = document.createElement("li");
  li.className = "commit-row";
  const isHead = headHash && c.hash === headHash;

  // 主行:圆点 + 当前标签 + message + 归属/时间 + 回退(默认不显示 ID)
  const main = document.createElement("div");
  main.className = "commit-main";

  const caret = document.createElement("span");
  caret.className = "commit-caret" + (isHead ? " head" : "");
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  main.appendChild(caret);

  // 归属图标(本地/远程)位于左侧文字前:双槽位固定渲染,缺失槽 visibility:hidden 占位,
  // 保证所有行图标同列、消息文字从同一 x 起点开始
  const loci = document.createElement("span");
  loci.className = "commit-loci";
  const loc = document.createElement("span");
  loc.className = "loci-local";
  loc.title = "本地分支";
  loc.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  if (!c.local) loc.classList.add("none");
  loci.appendChild(loc);
  const rem = document.createElement("span");
  rem.className = "loci-remote";
  rem.title = "远程分支";
  rem.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  if (!c.remote) rem.classList.add("none");
  loci.appendChild(rem);
  main.appendChild(loci);

  if (isHead) {
    const tag = document.createElement("span");
    tag.className = "h-head-tag";
    tag.textContent = "当前";
    tag.title = "当前所在的位置（本地最新提交）";
    main.appendChild(tag);
  }

  const msg = document.createElement("span");
  msg.className = "commit-msg";
  msg.textContent = c.subject;
  main.appendChild(msg);

  const time = document.createElement("span");
  time.className = "commit-time";
  time.textContent = relTimeShort(c.timestamp);
  time.title = relTime(c.timestamp);
  const meta = document.createElement("span");
  meta.className = "commit-meta";
  meta.append(time);
  main.appendChild(meta);

  const rb = document.createElement("button");
  rb.className = "rollback";
  rb.textContent = "回退";
  rb.disabled = isHead;
  rb.title = isHead ? "当前提交，不可回退" : "强制回退到此版本（丢弃之后所有提交）";
  rb.addEventListener("click", (ev) => {
    ev.stopPropagation();
    askReset(c.hash, c.short);
  });
  main.appendChild(rb);
  li.appendChild(main);

  // 展开后详情:作者 · 完整相对时间 · 完整 hash
  const detail = document.createElement("div");
  detail.className = "commit-detail";
  const part = (txt, cls) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = txt; return s; };
  detail.append(part(c.author), part("·"), part(relTime(c.timestamp)), part("·"), part(c.hash, "cd-hash"));
  li.appendChild(detail);

  // 点击行(回退按钮已 stopPropagation)切换展开/收起;同时只允许展开一个,
  // 点击展开某行时自动收起其他已展开行
  li.addEventListener("click", () => {
    if (li.classList.contains("expanded")) {
      li.classList.remove("expanded");
      return;
    }
    document.querySelectorAll(".commit-row.expanded").forEach((el) => el.classList.remove("expanded"));
    li.classList.add("expanded");
  });
  return li;
}

// 本地 + 远程按 hash 去重合并,按时间倒序;同时标记每条提交的本地/远程归属
function mergeCommits(local, remote) {
  const map = new Map();
  for (const c of local) map.set(c.hash, { ...c, local: true, remote: false });
  for (const c of remote) {
    const ex = map.get(c.hash);
    if (ex) ex.remote = true;
    else map.set(c.hash, { ...c, local: false, remote: true });
  }
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/* ===== 强制回退 ===== */
let resetHash = null;
function askReset(hash, short) {
  resetHash = hash;
  $("reset-target").textContent = short;
  $("dlg-reset").classList.remove("hidden");
}

async function doReset() {
  if (!resetHash) return;
  $("dlg-reset").classList.add("hidden");
  setButtonLoading($("btn-reset-confirm"), true, "回退中…");
  let ok = false;
  try {
    const r = await invoke("git_reset_hard", { repo, hash: resetHash });
    ok = r && r.ok;
    if (!ok) toast(r.output, false);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-reset-confirm"), false);
  }
  resetHash = null;
  await refresh();
  if (ok) toast("已强制回退", true);
}

/* ===== 存档点(Checkpoint) ===== */
// 存档点条目:复用 .commit-row 外壳,用旗帜图标 + 「存档点」标签区分,
// 按时间穿插进版本时间线。hover 显示「删除」「读档」操作。
function checkpointRow(cp) {
  const li = document.createElement("li");
  li.className = "commit-row checkpoint-row";
  const main = document.createElement("div");
  main.className = "commit-main";

  // 旗帜图标(占 commit-caret 的列宽,文字列与提交行对齐)
  const flag = document.createElement("span");
  flag.className = "cp-flag";
  flag.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>';
  main.appendChild(flag);

  // 占位对齐 commit-loci 的 30px 列宽
  const loci = document.createElement("span");
  loci.className = "commit-loci";
  main.appendChild(loci);

  const tag = document.createElement("span");
  tag.className = "cp-tag";
  tag.textContent = "存档点";
  main.appendChild(tag);

  // 可读标识:有 label 用 label,否则用相对时间(如「刚刚」「5分前」)
  const msg = document.createElement("span");
  msg.className = "commit-msg cp-label";
  const hasLabel = cp.label && cp.label.trim();
  msg.textContent = hasLabel ? cp.label : relTimeShort(cp.timestamp);
  msg.title = relTime(cp.timestamp);
  main.appendChild(msg);

  const time = document.createElement("span");
  time.className = "commit-time";
  time.textContent = relTimeShort(cp.timestamp);
  time.title = relTime(cp.timestamp);
  const meta = document.createElement("span");
  meta.className = "commit-meta";
  meta.append(time);
  main.appendChild(meta);

  // 操作按钮(悬停显示,绝对定位右侧):删除 + 读档
  const actions = document.createElement("span");
  actions.className = "cp-actions";
  const del = document.createElement("button");
  del.className = "cp-act";
  del.textContent = "删除";
  del.title = "删除此存档点（仅移除标记，不影响代码）";
  del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteCheckpoint(cp.id); });
  const restore = document.createElement("button");
  restore.className = "cp-act";
  restore.textContent = "读档";
  restore.title = "回到此存档点的完整状态";
  restore.addEventListener("click", (ev) => { ev.stopPropagation(); askRestore(cp.id); });
  actions.append(del, restore);
  main.appendChild(actions);

  li.appendChild(main);
  return li;
}

// 一键打点(不弹框,label 留空,时间线条目用相对时间标识)
async function createCheckpoint() {
  if (!repo) return;
  setButtonLoading($("btn-checkpoint"), true, "存档中…");
  let ok = false;
  try {
    await invoke("checkpoint_create", { repo, label: null });
    ok = true;
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-checkpoint"), false);
  }
  await refresh();
  if (ok) toast("已创建存档点", true);
}

let restoreId = null;
function askRestore(id) {
  restoreId = id;
  $("dlg-restore").classList.remove("hidden");
}

async function doRestore() {
  if (!restoreId) return;
  $("dlg-restore").classList.add("hidden");
  setButtonLoading($("btn-restore-confirm"), true, "读档中…");
  let ok = false;
  try {
    await invoke("checkpoint_restore", { repo, id: restoreId });
    ok = true;
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-restore-confirm"), false);
  }
  restoreId = null;
  await refresh();
  if (ok) toast("已读档到存档点", true);
}

async function deleteCheckpoint(id) {
  try {
    await invoke("checkpoint_delete", { repo, id });
    toast("已删除存档点", true);
  } catch (e) {
    toast(String(e), false);
  }
  await refresh();
}

/* ===== 事件绑定 ===== */
export function bindHistoryEvents() {
  $("btn-checkpoint").addEventListener("click", createCheckpoint);
  $("btn-reset-cancel").addEventListener("click", () => $("dlg-reset").classList.add("hidden"));
  $("btn-reset-confirm").addEventListener("click", doReset);
  $("btn-restore-cancel").addEventListener("click", () => $("dlg-restore").classList.add("hidden"));
  $("btn-restore-confirm").addEventListener("click", doRestore);
}

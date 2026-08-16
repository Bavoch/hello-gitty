/* 历史时间线:本地/远程提交合并展示、强制回退 */
import { $, invoke, toast, setButtonLoading, relTime, relTimeShort, repo, setNumBadge } from "./state.js";
import { refresh } from "./panel.js";

export function renderHistory(h, branch) {
  const box = $("history-container");
  box.innerHTML = "";
  const remote = h.remote ? h.remote.commits : [];
  const commits = mergeCommits(h.commits, remote);
  setNumBadge($("history-count"), commits.length, "plain");
  if (!commits.length) {
    const none = document.createElement("div");
    none.className = "history-none";
    none.textContent = "暂无提交";
    box.appendChild(none);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "history-list";
  for (const c of commits) ul.appendChild(commitRow(c, h.head));
  box.appendChild(ul);
}

function commitRow(c, headHash) {
  const li = document.createElement("li");
  li.className = "commit-row";
  const isHead = headHash && c.hash === headHash;
  const main = document.createElement("div");
  main.className = "commit-main";

  const caret = document.createElement("span");
  caret.className = "commit-caret";
  caret.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  main.appendChild(caret);

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
  rem.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  if (!c.remote) rem.classList.add("none");
  loci.appendChild(rem);
  main.appendChild(loci);

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
  // HEAD 提交不可回退:悬停显示「当前版本」占位(禁用态),其余显示「回退」
  rb.textContent = isHead ? "当前版本" : "回退";
  rb.disabled = isHead;
  rb.title = isHead ? "当前提交" : "强制回退到此版本（丢弃之后所有提交）";
  rb.addEventListener("click", (ev) => {
    ev.stopPropagation();
    askReset(c.hash, c.short);
  });
  main.appendChild(rb);
  li.appendChild(main);

  const detail = document.createElement("div");
  detail.className = "commit-detail";
  const part = (txt, cls) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = txt; return s; };
  detail.append(part(c.author), part("·"), part(relTime(c.timestamp)), part("·"), part(c.hash, "cd-hash"));
  li.appendChild(detail);

  // 提交信息正文(如有):展开时显示在详情下方
  if (c.body) {
    const body = document.createElement("div");
    body.className = "commit-body";
    body.textContent = c.body;
    li.appendChild(body);
  }
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

export function bindHistoryEvents() {
  $("btn-reset-cancel").addEventListener("click", () => $("dlg-reset").classList.add("hidden"));
  $("btn-reset-confirm").addEventListener("click", doReset);
}

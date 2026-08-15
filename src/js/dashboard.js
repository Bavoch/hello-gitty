/* 多仓库总览:全部项目状态一览(冲突/待推送/更改/最近提交),点击行进入项目 */
import { $, repos, view, setView, repoAvatarColor, relTime, relTimeShort } from "./state.js";
import { switchRepo, loadRepos, updateSidebarActive } from "./sidebar.js";

// 进入总览:先用现有摘要立即渲染(避免空白),再后台重扫刷新计数
export async function showOverview() {
  if (view === "overview") return;
  setView("overview");
  $("btn-overview").classList.add("active");
  updateSidebarActive(null); // 清掉项目列表全部高亮
  $("project-header").classList.add("hidden");
  $("toolbar").classList.add("hidden");
  $("empty-state").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  renderDashboard(); // 先用现有摘要立即渲染,避免空白
  await loadRepos(); // 后台重扫刷新计数(loadRepos 在总览态自动重渲染总览)
}

// 离开总览:恢复仓库级界面骨架(内容由 refresh/showPanel/showEmpty 填充),幂等
export function leaveOverview() {
  setView("repo");
  $("btn-overview").classList.remove("active");
  $("dashboard").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
}

// 总览关注度分组:冲突 > 待推送 > 有未提交 > 干净 > 非 Git
function overviewRank(r) {
  if (r.conflicts > 0) return 0;
  if (r.ahead > 0) return 1;
  if (r.staged + r.unstaged > 0) return 2;
  return r.is_repo ? 3 : 4;
}

export function renderDashboard() {
  const rows = [...repos].sort(
    (a, b) => overviewRank(a) - overviewRank(b) || (b.last_commit_ts || 0) - (a.last_commit_ts || 0)
  );
  // 顶部统计:仅显示非零段;全部干净时给出「全部已同步」
  const nPush = repos.filter((r) => r.ahead > 0).length;
  const nDirty = repos.filter((r) => r.is_repo && r.staged + r.unstaged > 0).length;
  const nConf = repos.filter((r) => r.conflicts > 0).length;
  const stats = $("dash-stats");
  stats.innerHTML = "";
  const seg = (text, cls) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    stats.appendChild(s);
  };
  seg(repos.length + " 个项目");
  if (nConf) seg(nConf + " 冲突", "st-conf");
  if (nPush) seg(nPush + " 待推送", "st-push");
  if (nDirty) seg(nDirty + " 有更改", "st-dirty");
  if (!nConf && !nPush && !nDirty && repos.length) seg("全部已同步", "st-clean");
  const list = $("dash-list");
  list.innerHTML = "";
  for (const r of rows) list.appendChild(dashRow(r));
}

// 总览单行:图标 | 名称+分支 | 同步(↑/↓) | 更改 | 冲突 | 最近提交,点击进入项目
function dashRow(r) {
  const li = document.createElement("li");
  li.className = "dash-row";
  li.title = r.path;

  const ic = document.createElement("span");
  ic.className = "dash-icon";
  if (r.icon) {
    const img = document.createElement("img");
    img.src = r.icon;
    img.alt = "";
    img.draggable = false;
    ic.appendChild(img);
  } else {
    // 字母头像:配色与侧栏一致(按路径哈希稳定分配)
    const c = repoAvatarColor(r.path);
    const av = document.createElement("span");
    av.className = "repo-avatar";
    av.style.background = c.bg;
    av.style.color = c.fg;
    av.textContent = ((r.name || r.path).trim().charAt(0) || "?").toUpperCase();
    ic.appendChild(av);
  }

  const main = document.createElement("div");
  main.className = "dash-main";
  const name = document.createElement("span");
  name.className = "dash-name";
  name.textContent = r.name;
  main.appendChild(name);
  if (r.is_repo) {
    const branch = document.createElement("span");
    branch.className = "dash-branch";
    branch.textContent = r.branch || "（分离）";
    main.appendChild(branch);
  } else {
    const tag = document.createElement("span");
    tag.className = "dash-branch";
    tag.textContent = "非 Git 仓库";
    main.appendChild(tag);
  }

  const sync = document.createElement("span");
  sync.className = "dash-cell";
  if (r.is_repo) {
    if (r.ahead > 0) sync.appendChild(dashBadge("↑" + r.ahead, "push", "本地领先 " + r.ahead + " 个提交，可推送"));
    if (r.behind > 0) sync.appendChild(dashBadge("↓" + r.behind, "pull", "远程领先 " + r.behind + " 个提交，可拉取"));
  }

  const dirty = document.createElement("span");
  dirty.className = "dash-cell";
  if (r.is_repo && r.staged + r.unstaged > 0) {
    dirty.appendChild(dashBadge(r.staged + r.unstaged + " 处更改", "dirty", "未提交的本地修改（暂存 " + r.staged + " · 更改 " + r.unstaged + "）"));
  }

  const conf = document.createElement("span");
  conf.className = "dash-cell";
  if (r.conflicts > 0) conf.appendChild(dashBadge(r.conflicts + " 冲突", "conf", "合并冲突待解决"));

  const time = document.createElement("span");
  time.className = "dash-time";
  if (r.is_repo) {
    if (r.last_commit_ts) {
      time.textContent = relTimeShort(r.last_commit_ts);
      time.title = relTime(r.last_commit_ts);
    } else {
      time.textContent = "无提交";
    }
  }

  li.append(ic, main, sync, dirty, conf, time);
  li.addEventListener("click", () => switchRepo(r.path));
  return li;
}

function dashBadge(text, cls, title) {
  const b = document.createElement("span");
  b.className = "dash-badge " + cls;
  b.textContent = text;
  if (title) b.title = title;
  return b;
}

/* ===== 事件绑定 ===== */
export function bindDashboardEvents() {
  $("btn-overview").addEventListener("click", showOverview);
}

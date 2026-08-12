/* Hello Gitty 前端逻辑:纯 vanilla,通过 __TAURI__ 全局调用后端命令 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const DEFAULT_AI = { base_url: "https://api.deepseek.com", api_key: "", model: "deepseek-v4-flash", lang: "中文", commit_mode: "auto", prompt_preset: "conventional", custom_prompt: "" };
const STATUS_CHARS = { A: "A", M: "M", D: "D", R: "R", C: "C", U: "?", "?": "?" };

const SIDEBAR_MIN = 48, SIDEBAR_MAX = 420; // 侧栏拖拽宽度范围
const SIDEBAR_COMPACT_MAX = 96; // 简洁展示的宽度上限(含);更宽自动切全面展示

let settings = { ai: { ...DEFAULT_AI }, last_repo: null, repos: [] };
let repos = []; // 侧栏仓库摘要列表
let repo = null;
let busy = false;
let pendingPush = false; // 推送流程:等待手动填写提交信息后自动继续推送
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

  // 恢复侧栏宽度;简洁/全面展示由宽度自动决定
  let sbw = settings.sidebar_width || 172;
  if (settings.sidebar_collapsed && sbw > SIDEBAR_COMPACT_MAX) sbw = 48; // 兼容旧配置
  $("sidebar").style.width = sbw + "px";

  bindEvents();
  listen("conflict-progress", (e) => {
    const p = e.payload;
    $("conflict-current").textContent = `(${p.done}/${p.total}) ${p.path}`;
    $("conflict-fill").style.width = `${Math.round((p.done / p.total) * 100)}%`;
  });

  setupDragDrop();
  await loadRepos();
  if (repo) {
    await refresh();
  } else {
    showEmpty(false);
  }
}

function bindEvents() {
  $("btn-open2").addEventListener("click", openLocalRepo);
  $("btn-add-repo").addEventListener("click", () => showEmpty(false));
  $("btn-clone").addEventListener("click", cloneRepo);
  $("clone-dest").addEventListener("click", async () => {
    const dir = await invoke("pick_folder");
    if (dir) $("clone-dest").value = dir;
  });
  $("btn-clone-confirm").addEventListener("click", doClone);
  $("btn-clone-cancel").addEventListener("click", () => $("dlg-clone").classList.add("hidden"));
  $("btn-diff-close").addEventListener("click", () => $("dlg-diff").classList.add("hidden"));
  $("btn-init").addEventListener("click", initRepo);
  $("btn-stage-all").addEventListener("click", () => stageAll(true));
  $("btn-unstage-all").addEventListener("click", () => stageAll(false));
  $("btn-commit").addEventListener("click", onCommit);
  $("btn-push").addEventListener("click", () => pushPull("push"));
  $("btn-pull").addEventListener("click", () => pushPull("pull"));
  $("btn-branch").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("branch-menu");
    if (menu.classList.contains("hidden")) openBranchMenu();
    else menu.classList.add("hidden");
  });
  $("branch-menu").addEventListener("click", (e) => e.stopPropagation());
  $("btn-ai-resolve").addEventListener("click", resolveAllConflicts);
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-pin").addEventListener("click", togglePin);

  // 侧栏宽度拖拽调整(宽度同时决定简洁/全面展示,见 applySidebarMode)
  let sidebarDragStartX = 0, sidebarDragStartW = 0;
  const onSidebarDrag = (e) => {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarDragStartW + e.clientX - sidebarDragStartX));
    $("sidebar").style.width = w + "px";
  };
  const endSidebarDrag = () => {
    $("sidebar-resizer").classList.remove("dragging");
    document.body.classList.remove("resizing");
    document.removeEventListener("pointermove", onSidebarDrag);
    settings.sidebar_width = parseInt($("sidebar").style.width, 10);
    settings.sidebar_collapsed = $("sidebar").classList.contains("collapsed");
    invoke("settings_save", { settings }).catch(() => {});
  };
  // 侧栏收起/展开:在简洁(48px)与上次宽度间切换
  $("btn-toggle-sidebar").addEventListener("click", () => {
    const sb = $("sidebar");
    if (sb.classList.contains("collapsed")) {
      // 展开:恢复到记忆宽度,至少为默认 172(避免从拖窄的简洁态展开到过窄宽度)
      sb.style.width = Math.max(settings.sidebar_width || 172, 172) + "px";
    } else {
      settings.sidebar_width = parseInt(sb.style.width, 10) || 172;
      sb.style.width = "48px";
    }
    applySidebarMode();
    settings.sidebar_collapsed = sb.classList.contains("collapsed");
    invoke("settings_save", { settings }).catch(() => {});
  });

  $("sidebar-resizer").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sidebarDragStartX = e.clientX;
    sidebarDragStartW = $("sidebar").getBoundingClientRect().width;
    $("sidebar-resizer").classList.add("dragging");
    document.body.classList.add("resizing");
    document.addEventListener("pointermove", onSidebarDrag);
    document.addEventListener("pointerup", endSidebarDrag, { once: true });
  });

  // 侧栏宽度变化(拖拽调整、收起切换、初始布局)时:
  // 自动切换简洁/全面展示,并重新按可用宽度省略路径文本
  new ResizeObserver(() => { applySidebarMode(); fitAllPaths(); }).observe($("sidebar"));

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
      $("dlg-ignore").classList.add("hidden");
      toast(add.length ? "已添加到 .gitignore： " + add.join("、") : "所选规则已存在，无需添加", add.length > 0);
      await refresh();
    } catch (e) { toast(String(e), false); }
    finally { setButtonLoading($("btn-ignore-confirm"), false); }
  });
  $("btn-ignore-cancel").addEventListener("click", () => $("dlg-ignore").classList.add("hidden"));
  document.addEventListener("click", () => {
    $("more-menu").classList.add("hidden");
    $("branch-menu").classList.add("hidden");
  });
  $("btn-settings-cancel").addEventListener("click", closeSettings);
  $("btn-settings-save").addEventListener("click", saveSettings);
  $("set-prompt-preset").addEventListener("change", updatePresetPreview);
  // 设置页左侧菜单:切换分组
  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".settings-nav-item").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("hidden", t.dataset.tab !== tab));
    });
  });
  $("btn-commit-cancel").addEventListener("click", () => {
    pendingPush = false; // 取消手动填写:中止自动推送流程
    $("dlg-commit").classList.add("hidden");
  });
  $("btn-commit-confirm").addEventListener("click", doCommit);
  $("btn-regen").addEventListener("click", regenMessage);
  $("btn-conflict-done").addEventListener("click", () => $("dlg-conflict").classList.add("hidden"));
  $("btn-merge-ai").addEventListener("click", () => {
    $("dlg-merge-conflict").classList.add("hidden");
    resolveAllConflicts();
  });
  $("btn-merge-manual").addEventListener("click", () => $("dlg-merge-conflict").classList.add("hidden"));
  $("btn-reset-cancel").addEventListener("click", () => $("dlg-reset").classList.add("hidden"));
  $("btn-reset-confirm").addEventListener("click", doReset);
  $("btn-token-cancel").addEventListener("click", () => $("dlg-token").classList.add("hidden"));
  $("btn-token-confirm").addEventListener("click", submitGithubToken);

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
async function openLocalRepo() {
  const dir = await invoke("pick_folder");
  if (!dir) return;
  await addRepoByPath(dir);
}

// 按路径添加项目并切换(供打开本地/拖拽复用)
async function addRepoByPath(dir) {
  try {
    settings.repos = await invoke("repos_add", { path: dir });
  } catch (e) { toast("添加失败：" + e, false); return; }
  repo = dir;
  settings.last_repo = dir;
  try { await invoke("repos_set_current", { path: dir }); } catch (_) {}
  await loadRepos();
  await refresh();
}

// 拖拽文件夹到窗口添加项目
async function setupDragDrop() {
  const getWin = window.__TAURI__?.window?.getCurrentWindow;
  if (!getWin) return;
  try {
    await getWin().onDragDropEvent((event) => {
      const p = event?.payload || event || {};
      if (p.type === "drop" && Array.isArray(p.paths) && p.paths.length) {
        addRepoByPath(p.paths[0]);
      }
    });
  } catch (_) { /* 拖拽不可用,静默 */ }
}

function cloneRepo() {
  $("clone-url").value = "";
  $("clone-dest").value = "";
  $("dlg-clone").classList.remove("hidden");
  $("clone-url").focus();
}

async function doClone() {
  const url = $("clone-url").value.trim();
  const dest = $("clone-dest").value.trim();
  if (!url) { toast("请输入仓库地址", false); return; }
  if (!dest) { toast("请选择本地目录", false); return; }
  setButtonLoading($("btn-clone-confirm"), true, "克隆中…");
  try {
    await invoke("git_clone", { url, dest });
    $("dlg-clone").classList.add("hidden");
    settings.repos = await invoke("repos_add", { path: dest });
    repo = dest;
    settings.last_repo = dest;
    try { await invoke("repos_set_current", { path: dest }); } catch (_) {}
    await loadRepos();
    await refresh();
    toast("克隆成功", true);
  } catch (e) { toast(String(e), false); }
  finally { setButtonLoading($("btn-clone-confirm"), false); }
}

async function loadRepos() {
  try { repos = await invoke("repos_status_all"); }
  catch (_) { /* 扫描失败时保留现有列表,不清空 */ }
  renderRepoList();
}

// 无图标项目的字母头像配色:10 种高区分度配色(与主题暗色系协调),按路径哈希稳定分配
const AVATAR_COLORS = [
  { bg: "#f4877133", fg: "#f48771" },
  { bg: "#89d18533", fg: "#89d185" },
  { bg: "#dcdcaa33", fg: "#dcdcaa" },
  { bg: "#75beff33", fg: "#75beff" },
  { bg: "#c792ea33", fg: "#c792ea" },
  { bg: "#f78c6c33", fg: "#f78c6c" },
  { bg: "#80cbc433", fg: "#80cbc4" },
  { bg: "#82aaff33", fg: "#82aaff" },
  { bg: "#ffcb6b33", fg: "#ffcb6b" },
  { bg: "#f0717833", fg: "#f07178" },
];

// 按路径哈希取配色:不同项目大概率不同色,同一项目每次渲染颜色稳定
function repoAvatarColor(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function renderRepoList() {
  const ul = $("repo-list");
  ul.innerHTML = "";
  $("sidebar-empty").classList.toggle("hidden", repos.length > 0);
  for (const r of repos) {
    const li = document.createElement("li");
    li.className = "repo-item" + (r.path === repo ? " active" : "");
    li.title = r.is_repo ? r.path : r.path + " · 不是 Git 仓库";

    const ic = document.createElement("span");
    ic.className = "repo-icon-wrap";
    if (r.icon) {
      const img = document.createElement("img");
      img.className = "repo-icon";
      img.src = r.icon;
      img.alt = "";
      ic.appendChild(img);
    } else {
      // 无真实图标:取项目名首字符做字母头像,配色按路径哈希稳定分配(同项目颜色不变)
      const c = repoAvatarColor(r.path);
      const av = document.createElement("span");
      av.className = "repo-avatar";
      av.style.background = c.bg;
      av.style.color = c.fg;
      av.textContent = ((r.name || r.path).trim().charAt(0) || "?").toUpperCase();
      ic.appendChild(av);
    }

    const info = document.createElement("div");
    info.className = "repo-info";
    const name = document.createElement("span");
    name.className = "repo-name";
    name.textContent = r.name;
    info.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "repo-meta";
    // 第二行展示项目路径;过长时按可用宽度智能省略(见 fitPath)
    meta.dataset.path = r.path;
    meta.textContent = r.path;
    info.append(name, meta);

    li.append(ic, info);
    li.addEventListener("click", () => switchRepo(r.path));
    ul.appendChild(li);
  }
  fitAllPaths(); // 渲染完成后按当前侧栏宽度做路径智能省略
  // 当前项(含新添加的项目)滚动到可视区,避免列表末尾新项在滚动区外不可见
  const active = ul.querySelector(".repo-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

// 路径智能省略:完整路径放得下就完整显示;放不下时保留「开头 + … + 结尾目录名」,
// 开头保留盘符/根路径,结尾保留项目目录名(与第一行项目名呼应),只省略中间不重要的部分。
function fitPath(el, path) {
  el.textContent = path;
  if (el.scrollWidth <= el.clientWidth + 1) return; // 完整显示
  // 按最后一个分隔符拆出「结尾目录名」与「其余部分」
  const sepIdx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (sepIdx <= 0 || sepIdx === path.length - 1) return; // 无有效目录名,交给 CSS 尾部省略
  const head = path.slice(0, sepIdx); // 不含末尾分隔符
  const tail = path.slice(sepIdx);    // 含分隔符,如 \hello-gitty
  // 二分查找:head 保留多少字符时 head + … + tail 恰好放得下
  let lo = 0, hi = head.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    el.textContent = head.slice(0, mid) + "…" + tail;
    if (el.scrollWidth <= el.clientWidth + 1) lo = mid; else hi = mid - 1;
  }
  el.textContent = head.slice(0, lo) + "…" + tail;
  // 极窄侧栏:连「… + 目录名」都放不下时,退化为「开头 + …」(项目名已在第一行)
  if (lo === 0 && el.scrollWidth > el.clientWidth + 1) {
    let a = 0, b = path.length;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      el.textContent = path.slice(0, mid) + "…";
      if (el.scrollWidth <= el.clientWidth + 1) a = mid; else b = mid - 1;
    }
    el.textContent = path.slice(0, a) + "…";
  }
}

// 侧栏宽度变化(拖拽调整、初始布局)后,重新对所有路径做智能省略
function fitAllPaths() {
  for (const el of $("repo-list").querySelectorAll(".repo-meta")) {
    fitPath(el, el.dataset.path || "");
  }
}

// 按当前宽度自动切换简洁(仅图标)与全面(名称+路径)展示。
// 简洁时「添加项目」按钮移到项目列表下方,全面时回到头部。
function applySidebarMode() {
  const sb = $("sidebar");
  const w = parseInt(sb.style.width, 10);
  const compact = !isNaN(w) && w <= SIDEBAR_COMPACT_MAX;
  sb.classList.toggle("collapsed", compact);
  if (compact) {
    $("repo-list").after($("btn-add-repo"));
  } else {
    $("sidebar-head").appendChild($("btn-add-repo"));
  }
  $("btn-toggle-sidebar").title = compact ? "展开侧边栏" : "收起侧边栏";
  return compact;
}

async function switchRepo(path) {
  if (path === repo) return;
  repo = path;
  settings.last_repo = path;
  try { await invoke("repos_set_current", { path }); } catch (_) {}
  renderRepoList();
  showRefreshing();
  await refresh();
}

async function removeRepo(path) {
  try { settings.repos = await invoke("repos_remove", { path }); }
  catch (e) { toast("关闭失败：" + e, false); return; }
  if (repo === path) {
    repo = settings.repos[0] || null;
    settings.last_repo = repo;
  }
  await loadRepos();
  if (repo) await refresh(); else showEmpty(false);
}

async function initRepo() {
  if (!repo) return;
  setButtonLoading($("btn-init"), true, "初始化…");
  try {
    await invoke("git_init", { repo });
    toast("仓库已初始化", true);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-init"), false);
  }
  await refresh();
  await loadRepos();
}

/* ===== 刷新 ===== */
async function refresh() {
  if (!repo) return;
  branchCache = null; // 仓库状态已变(切分支/推送/拉取等),分支缓存作废
  // 一次拉取合并的 status + history(后端复用 status 的 branch 信息,省去重复 git 进程)
  const data = await invoke("git_refresh", { repo });
  const st = data.status, hist = data.history;
  if (!st.is_repo) {
    showEmpty(true);
    updateSidebarCurrent(st);
    return;
  }
  showPanel(st);
  renderHistory(hist, st.branch);
  updateSidebarCurrent(st); // 侧栏只就地更新当前项,不做全量扫描
}

// 切换仓库时立即显示的加载占位:隐藏旧内容,给用户即时反馈
function showRefreshing() {
  $("empty-state").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("refreshing-state").classList.remove("hidden");
}

// 用已拿到的状态就地更新侧栏当前仓库项(零额外 git 调用)
function updateSidebarCurrent(st) {
  const idx = repos.findIndex((r) => r.path === repo);
  if (idx < 0) return;
  // 第二行现在只展示路径,状态徽标已移至右侧面板,此处仅同步是否 Git 仓库
  repos[idx] = { ...repos[idx], is_repo: st.is_repo };
  renderRepoList();
}

/* ===== 历史(本地/远程并排) ===== */
function renderHistory(h, branch) {
  const box = $("history-container");
  box.innerHTML = "";
  // 本地 + 远程按 hash 去重合并,按时间倒序(VS Code 风格单列时间线)
  const remote = h.remote ? h.remote.commits : [];
  const all = mergeCommits(h.commits, remote);
  $("history-count").textContent = all.length;
  if (!all.length) {
    const none = document.createElement("div");
    none.className = "history-none";
    none.textContent = "暂无提交";
    box.appendChild(none);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "history-list";
  for (const c of all) ul.appendChild(commitRow(c, h.head));
  box.appendChild(ul);
}

// 单个提交行:圆点 + hash + message + 作者·时间 + 回退
function commitRow(c, headHash) {
  const li = document.createElement("li");
  li.className = "commit-row";
  li.dataset.author = c.author;
  li.dataset.subject = c.subject;
  li.dataset.time = relTime(c.timestamp);
  const isHead = headHash && c.hash === headHash;

  const dot = document.createElement("span");
  dot.className = "commit-dot" + (isHead ? " head" : "");
  li.appendChild(dot);

  const hash = document.createElement("span");
  hash.className = "commit-hash" + (isHead ? " is-head" : "");
  hash.textContent = c.short;
  li.appendChild(hash);

  if (isHead) {
    const tag = document.createElement("span");
    tag.className = "h-head-tag";
    tag.textContent = "HEAD";
    li.appendChild(tag);
  }

  const msg = document.createElement("span");
  msg.className = "commit-msg";
  msg.textContent = c.subject;
  li.appendChild(msg);

  const meta = document.createElement("span");
  meta.className = "commit-meta";
  // 左侧图标:本地分支/远程分支归属;右侧:相对时间(提交人在悬停提示中可见)
  const loci = document.createElement("span");
  loci.className = "commit-loci";
  if (c.local) {
    const s = document.createElement("span");
    s.className = "loci-local";
    s.title = "本地分支";
    s.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
    loci.appendChild(s);
  }
  if (c.remote) {
    const s = document.createElement("span");
    s.className = "loci-remote";
    s.title = "远程分支";
    s.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
    loci.appendChild(s);
  }
  const time = document.createElement("span");
  time.textContent = relTimeShort(c.timestamp);
  time.title = relTime(c.timestamp);
  meta.append(loci, time);
  li.appendChild(meta);

  const rb = document.createElement("button");
  rb.className = "rollback";
  rb.textContent = "回退";
  rb.disabled = isHead;
  rb.title = isHead ? "当前 HEAD" : "强制回退到此版本（丢弃之后所有提交）";
  rb.addEventListener("click", (ev) => {
    ev.stopPropagation();
    askReset(c.hash, c.short);
  });
  li.appendChild(rb);
  li.addEventListener("mouseenter", () => showCommitTip(li));
  li.addEventListener("mouseleave", hideCommitTip);
  return li;
}

// git 历史悬停说明(自定义浮层,避免系统 title)
function showCommitTip(row) {
  const t = $("commit-tip");
  t.innerHTML = "";
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = txt; return e; };
  const meta = el("div", "ct-meta");
  meta.append(el("span", "", row.dataset.author), el("span", "ct-sep", "·"), el("span", "", row.dataset.time));
  t.append(el("div", "ct-msg", row.dataset.subject), meta);
  t.classList.remove("hidden");
  const rr = row.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  let top = rr.top - tr.height - 8;
  if (top < 8) top = rr.bottom + 8;
  t.style.top = top + "px";
  // 相对行首右移 16px,让提示面板错开行内容
  t.style.left = Math.max(8, Math.min(rr.left + 16, window.innerWidth - tr.width - 8)) + "px";
}
function hideCommitTip() { $("commit-tip").classList.add("hidden"); }

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

function relTime(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 紧凑版相对时间(并排窄列用):刚刚 / 5分前 / 3时前 / 2天前 / 8-01
function relTimeShort(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + "分前";
  if (s < 86400) return Math.floor(s / 3600) + "时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "天前";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}-${d.getDate()}`;
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

function showEmpty(showInit) {
  $("panel").classList.add("hidden");
  $("refreshing-state").classList.add("hidden");
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
  if ($("push-count")) $("push-count").classList.add("hidden");
  if ($("pull-count")) $("pull-count").classList.add("hidden");
}

function showPanel(st) {
  $("empty-state").classList.add("hidden");
  $("refreshing-state").classList.add("hidden");
  $("panel").classList.remove("hidden");

  renderList("conflict-list", st.conflicts, "conflict", $("conflict-count"));
  renderList("staged-list", st.staged, "staged", $("staged-count"));
  renderList("unstaged-list", [...st.unstaged, ...st.untracked], "unstaged", $("unstaged-count"));

  $("sec-conflicts").classList.toggle("hidden", st.conflicts.length === 0);
  $("btn-ai-resolve").disabled = st.conflicts.length === 0;
  // 右侧面板显示当前分支
  $("branch-name").textContent = st.detached ? "（分离）" : (st.branch || "（无分支）");
  $("branch-name").title = st.branch || "";
  // 领先/落后提交数徽标:推送按钮显示 ahead,拉取按钮显示 behind
  // (空值保护:HTML 与 JS 版本错位时不能中断整个刷新)
  const pc = $("push-count"), lc = $("pull-count");
  if (pc) {
    pc.classList.toggle("hidden", !(st.ahead > 0));
    if (st.ahead > 0) pc.textContent = st.ahead;
  }
  if (lc) {
    lc.classList.toggle("hidden", !(st.behind > 0));
    if (st.behind > 0) lc.textContent = st.behind;
  }
}

/* ===== 文件列表 ===== */
function renderList(listId, entries, kind, countEl) {
  const ul = $(listId);
  ul.innerHTML = "";
  countEl.textContent = entries.length;
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
    }
    li.appendChild(actions);

    li.addEventListener("click", () => {
      if (kind === "conflict") resolveOne(e.path);
      else showDiff(e, kind);
    });

    ul.appendChild(li);
  }
}

// 添加到 .gitignore:计算文件名/扩展名/目录候选规则
function askIgnore(path) {
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
    $("diff-content").innerHTML = '<span class="d-empty">' + String(err) + '</span>';
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

function stChar(e, kind) {
  if (kind === "conflict") return "C";
  if (e.untracked) return "?";
  if (kind === "staged") return STATUS_CHARS[e.x] || "M";
  return STATUS_CHARS[e.y] || "M";
}

/* ===== 操作 ===== */
async function stageAll(stage) {
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

async function toggleStage(path, unstage) {
  // 单文件暂存/取消暂存很快,不显示加载提示,静默执行
  try {
    const r = await invoke(unstage ? "git_unstage_file" : "git_stage_file", { repo, path });
    if (r && r.ok === false) toast(r.output, false);
  } catch (e) {
    toast(String(e), false);
  }
  await refresh();
}

async function onCommit() {
  // 提交只针对已暂存内容,不再自动暂存全部
  const st = await invoke("git_status", { repo });
  if (st.staged.length === 0) {
    toast(st.unstaged.length + st.untracked.length > 0
      ? "没有已暂存的更改，请先点击「全部暂存」"
      : "没有可提交的更改", false);
    return;
  }

  let msg = "";
  setButtonLoading($("btn-commit"), true, "提交中…");
  try {
    msg = await invoke("ai_commit_message", { settings: settings.ai, repo });
    // 直接提交模式:AI 生成后立即提交
    if (settings.ai.commit_mode === "auto") {
      const r = await invoke("git_commit", { repo, message: msg });
      if (r && r.ok === false) toast(r.output, false);
      else toast("提交成功", true);
      await refresh();
      return;
    }
    showCommitDialog(msg, "AI 已生成，可修改后提交");
  } catch (e) {
    // AI 失败(如未配 Key):回退到手动填写确认,保证提交可用
    showCommitDialog("", "AI 生成失败：" + e + " 请手动填写：");
  } finally {
    setButtonLoading($("btn-commit"), false);
  }
}

function showCommitDialog(msg, hint) {
  $("commit-msg").value = msg;
  $("commit-hint").textContent = hint;
  $("dlg-commit").classList.remove("hidden");
  $("commit-msg").focus();
}

async function regenMessage() {
  setButtonLoading($("btn-regen"), true, "生成中…");
  try {
    const msg = await invoke("ai_commit_message", { settings: settings.ai, repo });
    $("commit-msg").value = msg;
    $("commit-hint").textContent = "AI 已重新生成，可修改后提交";
  } catch (e) {
    $("commit-hint").textContent = "AI 生成失败：" + e;
  } finally {
    setButtonLoading($("btn-regen"), false);
  }
}

async function doCommit() {
  const msg = $("commit-msg").value.trim();
  if (!msg) { toast("提交信息不能为空", false); return; }
  $("dlg-commit").classList.add("hidden");
  // 弹窗关闭后,在工具栏提交按钮上体现加载状态
  setButtonLoading($("btn-commit"), true, "提交中…");
  try {
    const r = await invoke("git_commit", { repo, message: msg });
    if (r && r.ok === false) toast(r.output, false);
    else {
      toast("提交成功", true);
      // 由推送触发的手动填写:提交完成后自动继续推送
      if (pendingPush) {
        pendingPush = false;
        await doPush();
      }
    }
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-commit"), false);
  }
  await refresh();
}

// 实际推送(git_push + 授权引导)
async function doPush() {
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

async function pushPull(kind) {
  if (kind === "push") {
    // 推送前:本地所有修改(暂存+未暂存+未跟踪)全部提交,再推送
    try {
      const st = await invoke("git_status", { repo });
      if (st.staged.length + st.unstaged.length + st.untracked.length > 0) {
        await invoke("git_stage_all", { repo });
        let msg = "";
        try {
          msg = await invoke("ai_commit_message", { settings: settings.ai, repo });
        } catch (e) {
          // AI 不可用:手动填写提交信息,确认后自动继续推送
          pendingPush = true;
          showCommitDialog("", "AI 生成提交信息失败：" + e + " 请手动填写，确认后将自动推送");
          return;
        }
        const r = await invoke("git_commit", { repo, message: msg });
        if (r && r.ok === false) { toast(r.output, false); return; }
      }
    } catch (e) { toast(String(e), false); return; }
    await doPush();
    await refresh();
    return;
  }
  // 拉取
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

async function resolveOne(path) {
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

/* ===== 设置 ===== */
async function openSettings() {
  $("set-base-url").value = settings.ai.base_url || DEFAULT_AI.base_url;
  $("set-api-key").value = settings.ai.api_key || "";
  $("set-model").value = settings.ai.model || DEFAULT_AI.model;
  $("set-lang").value = settings.ai.lang || "中文";
  $("set-commit-mode").value = settings.ai.commit_mode || "auto";
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
    `<div class="pp-label">系统提示词（system）</div>` +
    `<pre>${escapeHtml(p.system)}</pre>` +
    `<div class="pp-label">用户提示词模板（user，占位符会被替换）</div>` +
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
    commit_mode: $("set-commit-mode").value,
    prompt_preset: $("set-prompt-preset").value,
    custom_prompt: $("set-custom-prompt").value,
  };
  try {
    await invoke("settings_save", { settings });
    closeSettings();
    toast("设置已保存", true);
  } catch (e) {
    toast("保存失败：" + e, false);
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
}

/* 按钮级加载状态:按钮内显示 spinner + 文案,并隐藏全局忙碌指示 */
function setButtonLoading(btn, loading, text) {
  if (loading) {
    btn.dataset.orig = btn.innerHTML;
    btn.classList.add("loading");
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span>' + (text || "");
    $("sb-busy").classList.add("hidden");
  } else {
    btn.classList.remove("loading");
    if (btn.dataset.orig !== undefined) btn.innerHTML = btn.dataset.orig;
    delete btn.dataset.orig;
  }
}

function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* Hello Gitty 前端逻辑:纯 vanilla,通过 __TAURI__ 全局调用后端命令 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const DEFAULT_AI = { base_url: "https://api.deepseek.com", api_key: "", model: "deepseek-v4-flash", lang: "中文", commit_mode: "auto", custom_prompt: "" };
const STATUS_CHARS = { A: "A", M: "M", D: "D", R: "R", C: "C", U: "?", "?": "?" };

const SIDEBAR_MIN = 48, SIDEBAR_MAX = 420; // 侧栏拖拽宽度范围
const SIDEBAR_COMPACT_MAX = 96; // 简洁展示的宽度上限(含);更宽自动切全面展示

let settings = { ai: { ...DEFAULT_AI }, last_repo: null, repos: [] };
let repos = []; // 侧栏仓库摘要列表
let repo = null;
let busy = false;
let fetching = false; // 后台 fetch 防重入:定时器与手动刷新共用
const sectionUserSet = new Set(); // 用户手动切换过的分组:自动收起规则不再覆盖其状态
let toastTimer = null;
let lastShipStatus = null; // 最近一次仓库状态,供按钮在 loading 结束后重建
let lastStatus = null; // 当前仓库最新修改计数(暂存/更改/冲突),供侧栏状态行显示
let popState = "idle";     // 提交弹窗态:streaming(生成中) / ready(可编辑确认) / idle(关闭)
let streamCancelled = false; // 软取消:流式中忽略后续事件、不自动提交
let streamBusy = false;    // 流式 invoke 进行中(含已软取消但后端未返回),用于阻塞重复触发

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
  // 提交信息流式回填:弹窗打开且未软取消时,用后端推送的累积全文整体写入文本框
  listen("commit-stream", (e) => {
    if (popState !== "idle" && !streamCancelled) $("commit-stream-text").value = e.payload.text;
  });

  setupDragDrop();
  await loadRepos();
  if (repo) {
    await refresh();
    fetchRemote(); // 启动时后台核对一次远程状态
  } else {
    showEmpty(false);
  }
  // 定时后台 fetch:远程有新提交时,ahead/behind 徽标与远程历史自动更新
  setInterval(fetchRemote, 60_000);
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
  $("btn-discard-all").addEventListener("click", discardAll);
  $("btn-commit").addEventListener("click", () => onCommit());
  $("btn-push").addEventListener("click", async () => { await doPush(); await refresh(); });
  // 提交流式弹窗按钮
  $("commit-pop-close").addEventListener("click", cancelCommitPop);
  $("commit-pop-cancel").addEventListener("click", cancelCommitPop);
  $("commit-pop-regen").addEventListener("click", () => streamCommitMessage());
  $("commit-pop-ok").addEventListener("click", () => commitWithMessage($("commit-stream-text").value));
  $("btn-pull").addEventListener("click", doPull);
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
  // 侧栏拖拽排序:按下在各 li,移动/松手由文档统一接收(指针移出原项也能持续追踪)
  document.addEventListener("pointermove", onRepoDragMove);
  document.addEventListener("pointerup", onRepoDragUp);
  $("btn-settings-cancel").addEventListener("click", closeSettings);
  $("btn-settings-save").addEventListener("click", saveSettings);
  // 设置页左侧菜单:切换分组
  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".settings-nav-item").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("hidden", t.dataset.tab !== tab));
    });
  });
  $("btn-conflict-done").addEventListener("click", () => $("dlg-conflict").classList.add("hidden"));
  $("btn-merge-ai").addEventListener("click", () => {
    $("dlg-merge-conflict").classList.add("hidden");
    resolveAllConflicts();
  });
  $("btn-merge-manual").addEventListener("click", () => $("dlg-merge-conflict").classList.add("hidden"));
  $("btn-reset-cancel").addEventListener("click", () => $("dlg-reset").classList.add("hidden"));
  $("btn-reset-confirm").addEventListener("click", doReset);
  $("btn-discard-all-cancel").addEventListener("click", () => $("dlg-discard-all").classList.add("hidden"));
  $("btn-discard-all-confirm").addEventListener("click", doDiscardAll);
  $("btn-token-cancel").addEventListener("click", () => $("dlg-token").classList.add("hidden"));
  $("btn-token-confirm").addEventListener("click", submitGithubToken);

  document.querySelectorAll(".section-head").forEach((h) =>
    h.addEventListener("click", () => {
      const sec = h.closest(".section");
      sectionUserSet.add(sec.id); // 用户手动改过:后续刷新不再套用默认收起规则
      sec.classList.toggle("collapsed");
      $(h.dataset.target).classList.toggle("hidden");
    })
  );
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
  fetchRemote(); // 新添加的项目后台核对一次远程状态
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
    fetchRemote(); // 克隆后核对远程跟踪分支,徽标立即可用
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

let dragPath = null;       // 正在拖拽的项目路径
let dragState = null;      // pointerdown 待定状态(移动超过阈值前不视为拖拽)
let suppressClick = false; // 拖拽结束后抑制一次合成 click,避免误切仓库

// 清除所有项目的落点指示线
function clearDropIndicators() {
  for (const el of $("repo-list").querySelectorAll(".drop-above,.drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

// 根据纵坐标定位指针下的项目元素
function repoItemAtY(y) {
  for (const it of $("repo-list").querySelectorAll(".repo-item")) {
    const r = it.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) return it;
  }
  return null;
}

// 拖拽移动:超过阈值才进入拖拽,之后实时刷新落点指示(Tauri 默认拦截 HTML5 drop,故改用 pointer)
function onRepoDragMove(e) {
  if (!dragState) return;
  if (!dragPath) {
    const dx = e.clientX - dragState.x, dy = e.clientY - dragState.y;
    if (dx * dx + dy * dy < 16) return; // 4px 阈值:与点击区分
    dragPath = dragState.path;
    dragState.li.classList.add("dragging");
  }
  e.preventDefault(); // 抑制拖动过程中浏览器的默认文本选中
  clearDropIndicators();
  const target = repoItemAtY(e.clientY);
  if (target && target !== dragState.li) {
    const rect = target.getBoundingClientRect();
    target.classList.add(e.clientY - rect.top < rect.height / 2 ? "drop-above" : "drop-below");
  }
}

// 拖拽松手:按落点重排,并复位状态
function onRepoDragUp(e) {
  if (dragPath && dragState) {
    const target = repoItemAtY(e.clientY);
    if (target && target !== dragState.li) {
      const rect = target.getBoundingClientRect();
      reorderRepo(dragPath, target.dataset.path, e.clientY - rect.top < rect.height / 2);
    }
    dragState.li.classList.remove("dragging");
    clearDropIndicators();
    suppressClick = true;
    dragPath = null;
  }
  dragState = null;
}

// 拖拽落定:把 src 移到 target 之前(before=true)/之后,就地重排两份列表并持久化
function reorderRepo(srcPath, targetPath, before) {
  const srcIdx = repos.findIndex((r) => r.path === srcPath);
  if (srcIdx < 0) return;
  const [moved] = repos.splice(srcIdx, 1);
  let dstIdx = repos.findIndex((r) => r.path === targetPath);
  if (dstIdx < 0) repos.push(moved);
  else {
    if (!before) dstIdx += 1;
    repos.splice(dstIdx, 0, moved);
  }
  // settings.repos 仅存路径,顺序即展示顺序;重排后持久化,下次加载沿用
  settings.repos = repos.map((r) => r.path);
  invoke("settings_save", { settings }).catch(() => {});
  renderRepoList();
}

function renderRepoList() {
  const ul = $("repo-list");
  ul.innerHTML = "";
  $("sidebar-empty").classList.toggle("hidden", repos.length > 0);
  for (const r of repos) {
    const li = document.createElement("li");
    li.className = "repo-item" + (r.path === repo ? " active" : "");
    li.title = r.is_repo ? r.path : r.path + " · 不是 Git 仓库";
    li.dataset.path = r.path; // 拖拽落点定位用

    const ic = document.createElement("span");
    ic.className = "repo-icon-wrap";
    if (r.icon) {
      const img = document.createElement("img");
      img.className = "repo-icon";
      img.src = r.icon;
      img.alt = "";
      img.draggable = false; // 避免拖到图标时触发图片原生拖拽
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
    if (r.is_repo) {
      // 所有 Git 项目:第二行显示本地修改情况(暂存/更改计数或已全部提交)
      // 当前项目用最新刷新计数,其他项目用扫描摘要计数(后端已合并未跟踪)
      const c = r.path === repo && lastStatus
        ? lastStatus
        : { staged: r.staged, changed: r.unstaged, conflicts: r.conflicts };
      meta.textContent = repoStatusText(c);
    } else {
      // 非 Git 项目:第二行展示项目路径;过长时按可用宽度智能省略(见 fitPath)
      meta.dataset.path = r.path;
      meta.textContent = r.path;
    }
    info.append(name, meta);

    li.append(ic, info);
    li.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; } // 拖拽刚结束:吞掉合成 click
      switchRepo(r.path);
    });
    // pointer 实现拖拽:按下记录起点,移动超阈值才拖(普通点击仍可切换仓库)
    li.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 仅左键
      suppressClick = false;
      dragState = { path: r.path, li, x: e.clientX, y: e.clientY };
    });
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
    if (!el.dataset.path) continue; // 当前项目的状态文本行不参与路径省略
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
  fetchRemote(); // 切到新仓库后台核对远程状态
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
// 后台静默 fetch:更新本地远程跟踪分支,让 push/pull 徽标与远程历史反映最新状态。
// 失败静默(无远程/无网络/未配置凭据),不打断用户操作;完成后就地刷新当前仓库。
async function fetchRemote() {
  if (!repo || fetching) return;
  fetching = true;
  const target = repo;
  try {
    const r = await invoke("git_fetch", { repo });
    if (r && r.ok === false) return; // 无远程/无网络/认证失败等:静默忽略
    if (repo === target) await refresh(); // fetch 后重读状态,更新 ahead/behind 徽标
  } catch (_) { /* 静默 */ }
  finally { fetching = false; }
}

async function refresh() {
  if (!repo) return;
  branchCache = null; // 仓库状态已变(切分支/推送/拉取等),分支缓存作废
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
  lastStatus = {
    staged: st.staged.length,
    changed: st.unstaged.length + st.untracked.length,
    conflicts: st.conflicts.length,
  };
  const idx = repos.findIndex((r) => r.path === repo);
  if (idx < 0) return;
  repos[idx] = { ...repos[idx], is_repo: st.is_repo };
  renderRepoList();
}

// 侧栏项目第二行:本地修改情况(暂存:N，更改:N;全部干净时显示已全部提交)
function repoStatusText(c) {
  if (c.staged === 0 && c.changed === 0 && c.conflicts === 0) return "已全部提交";
  let t = "暂存：" + c.staged + "，更改：" + c.changed;
  if (c.conflicts > 0) t += "，冲突：" + c.conflicts;
  return t;
}

// 顶部标题栏:当前项目图标 + 名称(数据复用侧栏仓库摘要,无需额外请求)
function updateProjectHeader() {
  const hdr = $("project-header");
  const cur = repos.find((r) => r.path === repo);
  if (!cur) { hdr.classList.add("hidden"); return; }
  hdr.classList.remove("hidden");
  const wrap = $("proj-icon-wrap");
  wrap.innerHTML = "";
  if (cur.icon) {
    const img = document.createElement("img");
    img.className = "proj-icon";
    img.src = cur.icon;
    img.alt = "";
    wrap.appendChild(img);
  } else {
    // 无真实图标:取项目名首字符做字母头像,配色与侧栏一致(同项目颜色不变)
    const c = repoAvatarColor(cur.path);
    const av = document.createElement("span");
    av.className = "proj-avatar";
    av.style.background = c.bg;
    av.style.color = c.fg;
    av.textContent = ((cur.name || cur.path).trim().charAt(0) || "?").toUpperCase();
    wrap.appendChild(av);
  }
  $("proj-name").textContent = cur.name || cur.path;
  $("proj-path").textContent = cur.path;
  $("proj-path").title = cur.path;
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
  // 无项目时隐藏标题栏;当前选中项不是 Git 仓库时仍保留(项目已选定)
  $("project-header").classList.toggle("hidden", !repo);
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
  // 无仓库:提交/推送/拉取按钮复位为次要态(不禁用,点击有 toast 提示)
  lastShipStatus = null;
  for (const id of ["btn-commit", "btn-push", "btn-pull"]) {
    const b = $(id);
    if (b) b.classList.remove("primary");
  }
  if ($("commit-count")) $("commit-count").className = "btn-count hidden";
  if ($("push-count")) $("push-count").className = "btn-count hidden";
  if ($("pull-count")) $("pull-count").classList.add("hidden");
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
  const count = $("commit-count");
  const pending = st.staged.length + st.unstaged.length + st.untracked.length;
  btn.disabled = false;
  btn.title = pending > 0 ? "提交全部本地更改" : "没有可提交的更改";
  btn.classList.toggle("primary", pending > 0);
  if (count) {
    count.classList.toggle("hidden", pending === 0);
    if (pending > 0) count.textContent = pending;
  }
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
function refreshShipButtons() {
  if (lastShipStatus) {
    setCommitButton(lastShipStatus);
    setPushButton(lastShipStatus);
  }
}

function showPanel(st) {
  $("empty-state").classList.add("hidden");
  $("refreshing-state").classList.add("hidden");
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
  lastShipStatus = st;
  setCommitButton(st);
  setPushButton(st);
  // 拉取按钮同规则:有落后 → 主按钮样式;已同步 → 正常次要样式(永不禁用,空操作走 toast)
  const pb = $("btn-pull"), lc = $("pull-count");
  if (pb && !pb.classList.contains("loading")) {
    const dirty = st.behind > 0;
    pb.disabled = false;
    pb.title = dirty ? "拉取远程更新" : "已是最新";
    pb.classList.toggle("primary", dirty);
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

let discardTarget = null; // 丢弃确认:null=丢弃全部更改;路径=丢弃单个文件

function discardAll() {
  discardTarget = null;
  $("discard-title").textContent = "取消所有修改";
  $("discard-hint").textContent = "将丢弃所有未暂存与已暂存的改动，工作区恢复到上次提交的状态，此操作不可恢复。";
  $("btn-discard-all-confirm").textContent = "确认取消所有修改";
  $("dlg-discard-all").classList.remove("hidden");
}

// 单文件丢弃:复用确认框,标题/文案指向具体文件
function askDiscardFile(path) {
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
  if (!repo) { toast("请先打开项目", false); return; }
  // 弹窗已开或流式生成进行中时不重复触发
  if (popState !== "idle" || streamBusy) return;
  const st = await invoke("git_status", { repo });
  const total = st.staged.length + st.unstaged.length + st.untracked.length;
  if (total === 0) { toast("没有可提交的更改", false); return; }
  try {
    // 智能提交:有未暂存/未跟踪时先全部暂存,一次性提交完本地所有改动(对标 VS Code)
    if (st.staged.length < total) await invoke("git_stage_all", { repo });
    await streamCommitMessage();
  } catch (e) {
    toast(String(e), false);
  } finally {
    refreshShipButtons();
  }
}

/* ===== 提交信息流式就地弹窗 ===== */
// 打开弹窗:进入生成中态
function openCommitPop() {
  popState = "streaming";
  streamCancelled = false;
  const ta = $("commit-stream-text");
  ta.value = "";
  ta.disabled = true;
  $("commit-pop-title").textContent = "AI 正在生成提交信息…";
  $("commit-pop-spin").classList.remove("hidden");
  $("commit-pop-actions").classList.add("hidden");
  $("commit-pop").classList.remove("hidden");
}

function closeCommitPop() {
  popState = "idle";
  $("commit-pop").classList.add("hidden");
}

// 弹窗进入可编辑确认态
function readyCommitPopForEdit(msg) {
  const ta = $("commit-stream-text");
  ta.value = msg;
  ta.disabled = false;
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

// 实际推送(git_push + 授权引导)
async function doPush() {
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

async function doPull() {
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

  $("dlg-settings").classList.remove("hidden");
}

function closeSettings() { $("dlg-settings").classList.add("hidden"); }

async function saveSettings() {
  settings.ai = {
    base_url: $("set-base-url").value.trim() || DEFAULT_AI.base_url,
    api_key: $("set-api-key").value.trim(),
    model: $("set-model").value.trim() || DEFAULT_AI.model,
    lang: $("set-lang").value,
    commit_mode: $("set-commit-mode").value,
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
    btn.dataset.origDisabled = btn.disabled;
    btn.disabled = true;
    btn.dataset.orig = btn.innerHTML;
    btn.classList.add("loading");
    btn.innerHTML = '<span class="btn-spinner"></span>' + (text || "");
    $("sb-busy").classList.add("hidden");
  } else {
    btn.classList.remove("loading");
    if (btn.dataset.orig !== undefined) btn.innerHTML = btn.dataset.orig;
    delete btn.dataset.orig;
    // 恢复 loading 前的禁用态(工具栏按钮原本不禁用 → 恢复为可用)
    if (btn.dataset.origDisabled !== undefined) {
      btn.disabled = btn.dataset.origDisabled === "true";
      delete btn.dataset.origDisabled;
    }
  }
}

function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

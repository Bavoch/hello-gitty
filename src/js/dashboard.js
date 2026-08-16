/* 多仓库总览:KPI 统计卡 + 项目运行卡片。
   图表行均为按钮,点击进入对应项目;纯 SVG/CSS 手绘,不引入图表库 */
import { $, invoke, toast, setButtonLoading, settings, repos, view, setView, repoAvatarColor, urlPort, urlDisplay, setNumBadge } from "./state.js";
import { switchRepo, loadRepos, updateSidebarActive, openCtxMenu } from "./sidebar.js";
import { runningRepos, setExternalAll, startServerFor, stopServerFor, stopExternalServer, detectCommandsFor, activeCmdFor, runLastFor } from "./run-panel.js";

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
  $("run-panel").classList.add("hidden"); // 总览无底部运行栏
  $("dashboard").classList.remove("hidden");
  renderDashboard(); // 先用现有摘要立即渲染,避免空白
  refreshOverviewActivity(); // 后台汇总近一年提交，结果回来后只刷新热力图
  refreshOverviewRunning(); // 后台批量探测外部运行端口,结果回来后重渲染
  refreshOverviewPorts(); // 后台读取静态开发端口,结果回来后重渲染
  await loadRepos(); // 后台重扫刷新计数(loadRepos 在总览态自动重渲染总览)
}

// 批量探测全部项目的外部运行端口(本应用启动的进程由 server-status 事件实时维护,无需探测)。
// 自定义运行地址解析出的端口一并探测,否则项目跑在自定义端口上会被误判为未运行
async function refreshOverviewRunning() {
  try {
    const list = repos.map((r) => r.path);
    const extra = {};
    for (const [k, v] of Object.entries(settings.run_urls || {})) {
      const p = urlPort(v);
      if (p) extra[k] = [p];
    }
    const map = await invoke("server_external_check_all", { repos: list, extra });
    setExternalAll(map);
    if (view === "overview") renderDashboard();
  } catch (_) { /* 探测失败保持现状 */ }
}

// 各项目从项目文件推断的静态开发端口(路径 → [{port, source}]),未运行也能显示预期地址
const staticPorts = new Map();
async function refreshOverviewPorts() {
  try {
    const map = await invoke("server_ports_all", { repos: repos.map((r) => r.path) });
    for (const [k, v] of Object.entries(map || {})) staticPorts.set(k, v || []);
    if (view === "overview") renderDashboard();
  } catch (_) { /* 读取失败保持现状 */ }
}

// 离开总览:恢复仓库级界面骨架(内容由 refresh/showPanel/showEmpty 填充),幂等
export function leaveOverview() {
  setView("repo");
  $("btn-overview").classList.remove("active");
  $("dashboard").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
  $("run-panel").classList.remove("hidden"); // 恢复底部运行栏
}

// 状态归类(与关注度排序一致):冲突 > 待推送 > 有更改 > 干净 > 非 Git
function statusCat(r) {
  if (r.conflicts > 0) return "conflict";
  if (r.ahead > 0) return "push";
  if (r.staged + r.unstaged > 0) return "dirty";
  return r.is_repo ? "clean" : "nogit";
}

export function renderDashboard() {
  renderKpis();
  renderCategoryDonut();
  renderActivity();
  // 仓库列表可能在总览已打开时更新（扫描/添加/克隆），此时按新路径集重新汇总。
  if (activity.key !== repos.map((r) => r.path).slice().sort().join("\u001f")) refreshOverviewActivity();
  renderRunCards();
}

/* ===== 近一年提交热力图 ===== */
const ACTIVITY_DAYS = 365;
let activity = { days: [], total: 0, loaded: false, loading: false, key: "" };

function activityStart() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - (ACTIVITY_DAYS - 1));
  return day;
}

function dayKey(day) {
  return day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
}

async function refreshOverviewActivity() {
  const paths = repos.map((r) => r.path);
  const key = paths.slice().sort().join("\u001f");
  if (activity.loading || (activity.loaded && activity.key === key)) return;
  activity.loading = true;
  activity.key = key;
  renderActivity();
  const start = activityStart();
  try {
    const result = await invoke("repos_activity", { repos: paths, since: Math.floor(start.getTime() / 1000) });
    if (activity.key === key) {
      activity.days = result?.days || [];
      activity.total = result?.total || 0;
      activity.loaded = true;
    }
  } catch (_) {
    if (activity.key === key) activity.loaded = true;
  } finally {
    activity.loading = false;
    if (view === "overview") renderDashboard();
  }
}

function activityLevel(count, values) {
  if (!count) return 0;
  if (values.length === 1) return 4;
  const q = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
  if (count <= q(.25)) return 1;
  if (count <= q(.5)) return 2;
  if (count <= q(.75)) return 3;
  return 4;
}

function renderActivity() {
  const box = $("activity-heatmap");
  const total = $("activity-total");
  if (!box || !total) return;
  const paths = repos.map((r) => r.path);
  if (!paths.length) {
    total.textContent = "";
    box.textContent = "添加项目后显示近一年提交活动";
    box.className = "chart-empty";
    return;
  }
  box.className = "";
  box.innerHTML = "";
  total.textContent = activity.loading ? "汇总中…" : "近一年 " + activity.total + " 次提交";
  const counts = new Map(activity.days.map((d) => [d.date, d.count]));
  const values = [...counts.values()].sort((a, b) => a - b);
  const first = activityStart();
  const gridStart = new Date(first);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const last = new Date();
  last.setHours(0, 0, 0, 0);
  const weekCount = Math.ceil((last - gridStart + 86400000) / (7 * 86400000));

  // 格子尺寸自适应面板宽度:优先铺满可用宽度,但限制在 [5px, 12px] 区间内保持可读。
  // 一年最多 53 列 × (cell + gap);宽度不足时不再放大间距,格子继续缩小直至下限,
  // 低于下限则回退横向滚动(保留 .heatmap-scroll 的 overflow-x: auto)
  const gap = 3;
  const avail = (box.clientWidth || 0) - gap * (weekCount - 1);
  const cell = Math.max(5, Math.min(12, Math.floor(avail / weekCount)));

  const layout = document.createElement("div");
  layout.className = "heatmap-layout";
  const labels = document.createElement("div");
  labels.className = "heatmap-weekdays";
  labels.innerHTML = "<span></span><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span>";
  const scroll = document.createElement("div");
  scroll.className = "heatmap-scroll";
  const months = document.createElement("div");
  months.className = "heatmap-months";
  months.style.gridTemplateColumns = "repeat(" + weekCount + ", var(--heat-cell))";
  months.style.setProperty("--heat-cell", cell + "px");
  const grid = document.createElement("div");
  grid.className = "heatmap-grid";
  grid.style.gridTemplateColumns = "repeat(" + weekCount + ", var(--heat-cell))";
  grid.style.setProperty("--heat-cell", cell + "px");
  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  for (let i = 0; i < weekCount * 7; i++) {
    const day = new Date(gridStart);
    day.setDate(day.getDate() + i);
    const col = Math.floor(i / 7) + 1;
    const row = (i % 7) + 1;
    if (day.getDate() === 1 && row <= 2) {
      const month = document.createElement("span");
      month.textContent = monthNames[day.getMonth()];
      month.style.gridColumn = col;
      months.appendChild(month);
    }
    const cell = document.createElement("span");
    cell.className = "heatmap-cell l" + activityLevel(counts.get(dayKey(day)) || 0, values);
    cell.style.gridColumn = col;
    cell.style.gridRow = row;
    const count = counts.get(dayKey(day)) || 0;
    // 悬停显示当天提交数:自定义 tooltip 跟随鼠标(替代原生 title,即时可靠)
    cell.title = dayKey(day) + " · " + count + " 次提交";
    cell.setAttribute("aria-label", cell.title);
    cell.addEventListener("mouseenter", (e) => showHeatTip(e, dayKey(day), count));
    cell.addEventListener("mousemove", (e) => moveHeatTip(e));
    cell.addEventListener("mouseleave", hideHeatTip);
    grid.appendChild(cell);
  }
  scroll.append(months, grid);
  layout.append(labels, scroll);
  box.appendChild(layout);
}

// 热力图悬浮提示:显示日期与当天提交数,跟随鼠标;定位锚点为 .dash-activity
function showHeatTip(e, date, count) {
  const tip = $("heat-tooltip");
  tip.textContent = date + " · " + count + " 次提交";
  tip.classList.remove("hidden");
  moveHeatTip(e);
}
function moveHeatTip(e) {
  const tip = $("heat-tooltip");
  if (!tip || tip.classList.contains("hidden")) return;
  const anchor = tip.offsetParent || document.body; // .dash-activity(position: relative)
  const r = anchor.getBoundingClientRect();
  // 出现在鼠标右下方,边缘处翻转到左上方,避免超出面板
  const x = e.clientX - r.left + 12;
  const y = e.clientY - r.top + 12;
  tip.style.left = (x + tip.offsetWidth > r.width ? e.clientX - r.left - tip.offsetWidth - 12 : x) + "px";
  tip.style.top = (y + tip.offsetHeight > r.height ? e.clientY - r.top - tip.offsetHeight - 12 : y) + "px";
}
function hideHeatTip() {
  const tip = $("heat-tooltip");
  tip.classList.add("hidden");
}

// 当前项目列表中运行中的(本应用启动 + 外部检测),本应用启动的排前面
function liveRepos() {
  return runningRepos()
    .filter((x) => repos.some((r) => r.path === x.repo))
    .sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0));
}

/* ===== 项目运行:每个项目一张卡片(状态徽章 + 命令 + 启停/打开地址) =====
   外部运行的进程非本应用启动,不可停止,只提供打开地址(与运行面板规则一致) */

// 总览搜索关键词(项目名/路径不区分大小写包含匹配),空串显示全部
let dashQuery = "";
// 当前选中的分类 Tab(all = 全部)
let dashCat = "all";
// 卡片排序方式:modified = 最近提交时间倒序(默认)/ name = 名称 / run = 上次运行时间倒序
let dashSort = "modified";
const SORT_FNS = {
  modified: (a, b) => (b.last_commit_ts || 0) - (a.last_commit_ts || 0) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  run: (a, b) => runLastFor(b.path) - runLastFor(a.path) || a.name.localeCompare(b.name),
};

// 项目分类(与后端 repo_category 对应),用于筛选 Tab
const CATEGORIES = [
  { id: "web", label: "Web 应用" },
  { id: "desktop", label: "桌面端应用" },
  { id: "mobile", label: "移动端应用" },
  { id: "extension", label: "浏览器插件" },
  { id: "backend", label: "后端服务" },
  { id: "other", label: "其他项目" },
];

// 分类筛选 Tab:全部 + 实际存在的分类(带数量);点击切换并重渲染卡片。
// Tab 渲染在子容器中,避免重建时波及同一筛选栏里的搜索框
function renderTabs() {
  const bar = $("dash-cat-tabs");
  bar.innerHTML = "";
  $("dash-tabs").classList.toggle("hidden", !repos.length);
  const mk = (id, label, n) => {
    const b = document.createElement("button");
    b.className = "dash-tab" + (dashCat === id ? " active" : "");
    const t = document.createElement("span");
    t.textContent = label;
    const c = document.createElement("span");
    c.className = "n";
    c.textContent = n;
    b.append(t, c);
    b.addEventListener("click", () => {
      dashCat = id;
      renderRunCards();
    });
    return b;
  };
  bar.appendChild(mk("all", "全部", repos.length));
  for (const cat of CATEGORIES) {
    const n = repos.filter((r) => r.category === cat.id).length;
    if (n) bar.appendChild(mk(cat.id, cat.label, n));
  }
}

function renderRunCards() {
  renderTabs();
  const box = $("run-cards");
  box.innerHTML = "";
  if (!repos.length) { box.appendChild(emptyHint("暂无项目，点击右上角「扫描目录…」添加")); return; }
  const live = new Map(liveRepos().map((x) => [x.repo, x]));
  const q = dashQuery.trim().toLowerCase();
  const rows = repos
    .filter((r) => dashCat === "all" || r.category === dashCat)
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
    .sort(SORT_FNS[dashSort] || SORT_FNS.modified);
  if (!rows.length) {
    box.appendChild(emptyHint(q ? "没有匹配「" + dashQuery.trim() + "」的项目" : "该分类下暂无项目"));
    return;
  }
  for (const r of rows) box.appendChild(runCard(r, live.get(r.path)));
}

function runCard(r, x) {
  const card = document.createElement("div");
  card.className = "run-card";
  card.title = r.path;
  card.addEventListener("click", () => switchRepo(r.path)); // 点卡片空白处进入项目

  // 头部:项目名 | 状态徽章(仅运行中显示「运行中」)| 更多按钮(右上角)
  const head = document.createElement("div");
  head.className = "run-card-head";
  const name = document.createElement("span");
  name.className = "run-card-name";
  name.textContent = r.name;
  head.append(name);
  if (x && x.self) {
    const pill = document.createElement("span");
    pill.className = "run-pill self";
    pill.textContent = "运行中";
    head.append(pill);
  }
  const more = document.createElement("button");
  more.className = "card-more";
  more.title = "更多操作";
  more.textContent = "⋯";
  more.addEventListener("click", (e) => {
    e.stopPropagation(); // 不触发卡片点击(进入项目)
    const b = more.getBoundingClientRect();
    openCtxMenu(b.left, b.bottom + 4, r.path);
  });
  head.append(more);

  // 运行地址:自定义地址优先;其次运行中探测到的 Web 端口(可点击);
  // 再其次项目文件推断的静态地址;tauri 桌面端口是 WebView 内部资源不显示;
  // 未运行时灰色只读显示。显示形式经 urlDisplay:localhost 只显示端口,其余保留完整 URL
  const custom = (settings.run_urls || {})[r.path] || null;
  const webPorts = (x?.ports || []).filter((p) => p.source !== "tauri");
  const ports = webPorts.map((p) => p.port);
  const live = ports.length ? "http://localhost:" + ports[0] : null;
  const staticPort = (staticPorts.get(r.path) || []).find((p) => p.source !== "tauri");
  const inferred = staticPort ? "http://localhost:" + staticPort.port : null;
  const urlLine = document.createElement("div");
  urlLine.className = "run-card-url";
  if (x && (custom || live)) {
    // 点击热区仅限文字本身(行内 span),整行其余空白留给卡片点击(进入项目)
    const u = custom || live;
    const a = document.createElement("span");
    a.className = "link";
    a.textContent = urlDisplay(u);
    a.addEventListener("click", (e) => {
      e.stopPropagation(); // 不触发卡片点击(进入项目)
      invoke("open_url", { url: u });
    });
    urlLine.append(a);
  } else if (custom || inferred) {
    // 未运行但有推断端口:灰色只读显示预期地址(点击无动作,整行空白留给卡片点击)
    urlLine.textContent = urlDisplay(custom || inferred);
    urlLine.classList.add("dim");
  } else {
    // 无自定义/无推断端口:显示「无运行端口」;Tauri 桌面端口是 WebView 内部资源,无浏览器地址,同样提示
    urlLine.textContent = "无运行端口";
    urlLine.classList.add("dim");
  }

  // 操作区:统一为「命令下拉框(左)+ 运行/停止按钮(右)」
  // (外部运行:仅当探测确认了 pid 归属本项目才可停止,否则不可操作)
  const actions = document.createElement("div");
  actions.className = "run-card-actions";
  const mkBtn = (text, cls, fn, title, loadingText) => {
    const b = document.createElement("button");
    b.className = "mini-btn " + (cls || "");
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener("click", async (e) => {
      e.stopPropagation(); // 不触发卡片点击(进入项目)
      setButtonLoading(b, true, loadingText || text); // 执行中:禁用 + spinner 动态反馈
      try { await fn(); }
      finally { setButtonLoading(b, false); }
    });
    return b;
  };
  // 命令下拉框:所有状态统一显示项目支持的全部命令(已保存默认选中 + 历史,异步补充识别候选)
  const sel = document.createElement("select");
  sel.className = "run-cmd-select";
  sel.addEventListener("click", (e) => e.stopPropagation()); // 不触发卡片点击(进入项目)
  const saved = (settings.run_commands[r.path] || "").trim();
  const history = (settings.run_history || []).filter((c) => c !== saved).slice(0, 4);
  const opts = [saved, ...history].filter(Boolean);
  let selected = saved;
  // 运行中(本应用启动):下拉框只读,选中当前正在运行的命令
  if (x && x.self) {
    const active = activeCmdFor(r.path);
    if (active && !opts.includes(active)) opts.unshift(active);
    selected = active || saved;
    sel.disabled = true;
  }
  const fillOpts = () => {
    sel.innerHTML = "";
    for (const c of opts) {
      const op = document.createElement("option");
      op.value = op.textContent = c;
      sel.appendChild(op);
    }
    sel.classList.toggle("hidden", !opts.length);
    if (selected && opts.includes(selected)) sel.value = selected;
  };
  fillOpts();
  detectCommandsFor(r.path).then((list) => {
    if (!sel.isConnected) return; // 卡片已重渲染,丢弃
    for (const it of list || []) if (!opts.includes(it.cmd)) opts.push(it.cmd);
    selected = sel.value; // 保持当前选中不变
    fillOpts();
  }).catch(() => {});
  // 右侧按钮:运行中(含可停止的外部运行)为停止,否则为运行
  if (x && x.self) {
    actions.append(sel, mkBtn("■ 停止", "halt", () => stopServerFor(r.path), null, "停止中…"));
  } else if (x && x.ports && x.ports.some((p) => p.pid)) {
    const p = x.ports.find((q) => q.pid);
    actions.append(sel, mkBtn("■ 停止", "halt", () => stopExternalServer(r.path, p.port, p.pid), null, "停止中…"));
  } else {
    actions.append(sel, mkBtn("▶ 运行", "go", () => startServerFor(r.path, sel.value || undefined), "运行下拉框选中的命令；无选项时自动识别", "启动中…"));
  }

  // 布局:大图标独占左列(主视觉,修改数作角标),内容为右列
  const icCol = document.createElement("div");
  icCol.className = "run-card-ic";
  icCol.appendChild(rowIcon(r));
  if (r.is_repo && r.unstaged > 0) {
    // 修改数角标(全局数字角标组件):仅 >0 显示;非 Git 项目与无修改不显示
    const badge = document.createElement("span");
    setNumBadge(badge, r.unstaged, "run-card-badge");
    badge.title = r.unstaged + " 个文件已修改";
    icCol.appendChild(badge);
  }
  const body = document.createElement("div");
  body.className = "run-card-body";
  body.append(head, urlLine, actions);
  card.append(icCol, body);
  return card;
}

/* ===== 项目类型环形图 ===== */
// 分类配色:与分类 Tab 的语义一致,取稳定的低饱和色板
const DONUT_COLORS = {
  web: "#4a9eff", desktop: "#a5a8ff", mobile: "#39d353", extension: "#c792ea",
  backend: "#f0a89e", other: "#8a8f98",
};
function renderCategoryDonut() {
  const box = $("category-donut");
  if (!box) return;
  box.innerHTML = "";
  if (!repos.length) {
    box.textContent = "添加项目后显示类型分布";
    box.className = "chart-empty";
    return;
  }
  box.className = "";
  // 按 CATEGORIES 顺序汇总,未在列表中的分类(如自定义)归入 other
  const counts = new Map();
  for (const r of repos) counts.set(r.category || "other", (counts.get(r.category || "other") || 0) + 1);
  const rows = CATEGORIES
    .map((c) => ({ id: c.id, label: c.label, n: counts.get(c.id) || 0 }))
    .filter((r) => r.n > 0);
  // 未匹配到标准分类的项目(理论上 CATEGORIES 已覆盖,兜底显示)
  for (const [id, n] of counts) if (n > 0 && !CATEGORIES.some((c) => c.id === id)) rows.push({ id, label: id, n });

  const total = repos.length;
  const R = 40, C = 2 * Math.PI * R; // 圆环周长,用于 stroke-dasharray 分段
  let offset = 0;
  const arcs = [];
  for (const r of rows) {
    const frac = r.n / total;
    arcs.push(
      '<circle r="' + R + '" cx="48" cy="48" fill="none" stroke="' + (DONUT_COLORS[r.id] || DONUT_COLORS.other) +
      '" stroke-width="14" stroke-dasharray="' + (frac * C - 2) + " " + (C - frac * C + 2) +
      '" stroke-dashoffset="' + (-offset * C) + '" stroke-linecap="butt"/>'
    );
    offset += frac;
  }
  const chart = document.createElement("div");
  chart.className = "donut-chart";
  // 圆环 + 中心总数;旋转 -90° 让第一段从顶部开始
  chart.innerHTML =
    '<svg viewBox="0 0 96 96" width="96" height="96" style="transform:rotate(-90deg)">' +
    '<circle r="' + R + '" cx="48" cy="48" fill="none" stroke="var(--panel-2)" stroke-width="14"/>' +
    arcs.join("") + "</svg>" +
    '<span class="donut-total">' + total + "</span>";
  const legend = document.createElement("div");
  legend.className = "donut-legend";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "donut-legend-row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = DONUT_COLORS[r.id] || DONUT_COLORS.other;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = r.label;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = r.n;
    row.append(dot, name, n);
    legend.appendChild(row);
  }
  // 圆环 + 图例包进内容层:限制最大宽度并整体居中,间距有上限后不再拉大
  const inner = document.createElement("div");
  inner.className = "donut-inner";
  inner.append(chart, legend);
  box.append(inner);
}

/* ===== KPI 卡片 ===== */
// 图标为 24 viewBox 线性 SVG,与全局工具栏图标风格一致
const KPI_ICONS = {
  total: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  push: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  dirty: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  clean: '<path d="M22 11.1V12a10 10 0 1 1-5.93-9.14"/><path d="m8 11 3 3L22 4"/>',
  run: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};
function renderKpis() {
  const nPush = repos.filter((r) => r.ahead > 0).length;
  const nDirty = repos.filter((r) => r.is_repo && r.staged + r.unstaged > 0).length;
  const nClean = repos.filter((r) => statusCat(r) === "clean").length;
  const cards = [
    { icon: "total", v: repos.length, label: "个项目", color: "var(--text-head)" },
    { icon: "run", v: liveRepos().length, label: "运行中", color: "var(--accent-bright)" },
    { icon: "push", v: nPush, label: "待推送", color: "var(--blue)" },
    { icon: "dirty", v: nDirty, label: "有更改", color: "var(--orange)" },
    { icon: "clean", v: nClean, label: "已同步", color: "var(--green)" },
  ];
  const box = $("dash-cards");
  box.innerHTML = "";
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "kpi-card";
    // 大图标独占左列(主视觉),标签与数字为右列
    const ic = document.createElement("span");
    ic.className = "kpi-ic";
    ic.style.color = c.color;
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + KPI_ICONS[c.icon] + "</svg>";
    const body = document.createElement("div");
    body.className = "kpi-body";
    const head = document.createElement("div");
    head.className = "kpi-head";
    const label = document.createElement("span");
    label.textContent = c.label;
    head.append(label);
    const num = document.createElement("div");
    num.className = "kpi-num";
    num.textContent = c.v; // 数字统一白色强调(CSS),不再随卡片主题色
    body.append(head, num);
    card.append(ic, body);
    box.appendChild(card);
  }
}

/* ===== 条形图通用行:头像 | 名称 | 轨道 | 数值,整行可点击进入项目 ===== */
// 图标:真实图标或字母头像(配色与侧栏一致,按路径哈希稳定分配)
function rowIcon(r) {
  const ic = document.createElement("span");
  ic.className = "bar-ic";
  if (r.icon) {
    const img = document.createElement("img");
    img.src = r.icon;
    img.alt = "";
    img.draggable = false;
    ic.appendChild(img);
  } else {
    const c = repoAvatarColor(r.path);
    const av = document.createElement("span");
    av.className = "repo-avatar";
    av.style.background = c.bg;
    av.style.color = c.fg;
    av.textContent = ((r.name || r.path).trim().charAt(0) || "?").toUpperCase();
    ic.appendChild(av);
  }
  return ic;
}

function emptyHint(text) {
  const d = document.createElement("div");
  d.className = "chart-empty";
  d.textContent = text;
  return d;
}

/* ===== 添加项目:一次选择多个本地项目,不递归扫描子目录 ===== */
async function addProjects() {
  const paths = await invoke("pick_folders");
  if (!paths || !paths.length) return; // 用户取消
  const btn = $("btn-add-projects");
  setButtonLoading(btn, true, "添加中…");
  try {
    const before = new Set(settings.repos || []);
    for (const path of paths) {
      settings.repos = await invoke("repos_add", { path });
    }
    const added = paths.filter((path) => !before.has(path));
    await loadRepos(); // 总览态自动重渲染图表,侧栏列表同步更新
    refreshOverviewPorts(); // 新项目补充静态端口
    toast(added.length ? "已添加 " + added.length + " 个项目" : "所选项目已在列表中", true);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading(btn, false);
  }
}

/* ===== 事件绑定 ===== */
export function bindDashboardEvents() {
  $("btn-overview").addEventListener("click", showOverview);
  $("btn-add-projects").addEventListener("click", addProjects);
  // 面板宽度变化(窗口缩放/侧栏拖拽)时重算热力图格子尺寸,保持自适应。
  // 回调只会在 #activity-heatmap 自身尺寸变化时触发,重建内部子元素不会递归
  new ResizeObserver(() => { renderActivity(); }).observe($("activity-heatmap"));
  $("dash-search").addEventListener("input", (e) => {
    dashQuery = e.target.value;
    renderRunCards();
  });
  $("dash-sort").addEventListener("change", (e) => {
    dashSort = e.target.value;
    renderRunCards();
  });
}

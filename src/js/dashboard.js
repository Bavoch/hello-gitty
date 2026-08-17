/* 多仓库总览:KPI 统计卡 + 项目运行卡片。
   图表行均为按钮,点击进入对应项目;纯 SVG/CSS 手绘,不引入图表库 */
import { $, invoke, toast, setButtonLoading, settings, repos, view, setView, repoAvatarColor, urlPort, urlDisplay, setNumBadge } from "./state.js";
import { switchRepo, loadRepos, updateSidebarActive, openCtxMenu, updateRepoRunDots } from "./sidebar.js";
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
  $("diff-panel").classList.add("hidden"); // 总览无 diff 面板,关闭并清空
  $("diff-content").innerHTML = "";
  $("run-panel").classList.add("hidden"); // 总览无底部运行栏
  // 没有任何项目时:首页直接展示「新建项目」空态,不展示统计卡片
  // (保持 overview 视图与首页选中态,不走 showEmpty 的 leaveOverview 切回仓库视图)
  if (!repos.length) {
    $("dashboard").classList.add("hidden");
    $("empty-state").classList.remove("hidden");
    $("empty-title").textContent = "打开一个项目";
    $("empty-desc").textContent = "选择本地文件夹，或从远程仓库克隆";
    $("btn-init").classList.add("hidden");
    $("btn-open2").classList.remove("hidden");
    $("btn-clone").classList.remove("hidden");
    return;
  }
  $("dashboard").classList.remove("hidden");
  $("main").scrollTop = 0;
  renderDashboard({ preserveScroll: false }); // 先用现有摘要立即渲染,避免空白
  refreshOverviewActivity(); // 后台汇总近一年提交，结果回来后只刷新热力图
  refreshOverviewCode(); // 后台汇总近7日代码量,结果回来后只刷新柱状图
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
    if (view === "overview") {
      renderKpis();
      renderRunCards();
      updateRepoRunDots();
    }
  } catch (_) { /* 探测失败保持现状 */ }
}

// 各项目从项目文件推断的静态开发端口(路径 → [{port, source}]),未运行也能显示预期地址
const staticPorts = new Map();
async function refreshOverviewPorts() {
  try {
    const map = await invoke("server_ports_all", { repos: repos.map((r) => r.path) });
    for (const [k, v] of Object.entries(map || {})) staticPorts.set(k, v || []);
    if (view === "overview") renderRunCards();
  } catch (_) { /* 读取失败保持现状 */ }
}

// 离开总览:恢复仓库级界面骨架(内容由 refresh/showPanel/showEmpty 填充),幂等
export function leaveOverview() {
  setView("repo");
  $("btn-overview").classList.remove("active");
  $("dashboard").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
  // 恢复底部运行栏;项目已全部关闭时保持隐藏(与 sidebar 的 syncSidebarVisibility 口径一致,
  // 否则关闭最后一个项目后 showEmpty → leaveOverview 会把刚隐藏的运行栏重新显示)
  $("run-panel").classList.toggle("hidden", !repos.length);
}

let lastKpiKey = null; // 上次渲染 KPI/类型图的输入快照:输入未变时跳过整卡重建,避免条形图/图例闪烁
export function renderDashboard({ preserveScroll = true } = {}) {
  const main = $("main");
  const scrollTop = preserveScroll ? main.scrollTop : 0;
  // KPI 数字与类型堆叠图只读这些输入,快照未变时跳过重建(renderKpis 会销毁并重建
  // 内嵌类型图的容器,重建而不回填正是「图例出现后又消失」的根源,见 renderKpis 尾部说明)
  const kpiKey = [
    repos.length,
    liveRepos().length,
    repos.filter((r) => r.ahead > 0).length,
    repos.map((r) => r.category || "other").sort().join(","),
  ].join("|");
  if (kpiKey !== lastKpiKey) {
    lastKpiKey = kpiKey;
    renderKpis(); // 类型堆叠图随 KPI 卡一起重建并在 renderKpis 内立即回填
  }
  renderActivity();
  renderWeekBars();
  // 仓库列表可能在总览已打开时更新（扫描/添加/克隆），此时按新路径集重新汇总。
  const repoKey = repos.map((r) => r.path).slice().sort().join("\u001f");
  if (activity.key !== repoKey) refreshOverviewActivity();
  if (weekVol.key !== repoKey) refreshOverviewCode();
  renderRunCards();
  updateRepoRunDots(); // 总览重渲染(含外部运行探测结果)时同步侧栏绿点
  main.scrollTop = scrollTop;
}

/* ===== 近一年提交热力图 ===== */
const ACTIVITY_DAYS = 365;
let activity = { days: [], total: 0, loaded: false, loading: false, key: "" };
let heatScrollW = 0; // 上次渲染时 .heatmap-scroll 的实测宽度,首次渲染前为 0(回退外层宽度)
let lastMouse = null; // 最近一次鼠标位置:重渲染后据此恢复 tooltip(重建格子不会重触发 mouseenter)

// 读取热力图滚动容器的实际可用宽度:直接量 DOM,避免把星期标签列/内边距计入尺寸计算。
// 首次渲染时容器尚不存在,返回 0 由调用方回退到 box.clientWidth(下一帧量真实宽度修正)
function scrollBoxWidth() {
  const el = document.querySelector(".heatmap-scroll");
  if (el) heatScrollW = el.clientWidth;
  return heatScrollW;
}

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
    if (view === "overview") renderActivity();
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
  // 可用宽度必须在清空旧图之前测量:scrollBoxWidth 依赖 .heatmap-scroll 存在于文档中,
  // 清空后再读 clientWidth 会强制同步布局——此刻内容高度瞬间变小,#main 的 scrollTop
  // 被浏览器钳制回退,表现为主区滚动抽搐/无法滚到底部(热力图曾被每帧重建,持续触发)
  const estW = scrollBoxWidth() || box.clientWidth || 0;
  box.className = "";
  box.innerHTML = "";
  // 总数:数字(亮色) + 「次提交」紧凑拼接,不显示「近一年」前缀(标题已含)
  if (activity.loading) {
    total.textContent = "汇总中…";
  } else {
    total.textContent = "";
    const num = document.createElement("span");
    num.className = "act-num";
    num.textContent = activity.total;
    const unit = document.createElement("span");
    unit.className = "act-unit";
    unit.textContent = "次提交";
    total.append(num, unit);
  }
  const counts = new Map(activity.days.map((d) => [d.date, d.count]));
  const values = [...counts.values()].sort((a, b) => a - b);
  const first = activityStart();
  const gridStart = new Date(first);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  // 结束日延伸到本周行尾(周六):热力图画满当前行,未来天数用空格子填充右侧空白。
  // 行从周日开始(与 gridStart 取上周日对齐),行尾即周六
  const last = new Date();
  last.setHours(0, 0, 0, 0);
  last.setDate(last.getDate() + (6 - last.getDay()));
  const weekCount = Math.ceil((last - gridStart + 86400000) / (7 * 86400000));

  // 格子尺寸自适应面板宽度:按列数均分滚动容器的可用宽度,格子恰好铺满不溢出。
  // 宽度取 .heatmap-scroll(flex:1,实际摆放格子的容器)而非外层 box,
  // 避免把左侧星期标签列与内边距计入,导致格子偏大、右缘被裁。
  const gap = 3;
  const avail = estW - gap * (weekCount - 1);
  // 下限 5px 保持可读;触底时总宽可能超过容器,由 overflow-x 横向滚动,
  // 此时 grid 按 max-content 伸展,右缘格子完整可见(见 .heatmap-grid 样式)
  const cell = Math.max(5, Math.floor(avail / weekCount));

  const layout = document.createElement("div");
  layout.className = "heatmap-layout";
  layout.style.setProperty("--heat-cell", cell + "px"); // 定义在 layout 层:月份行/格子网格/星期标签列经继承共用同一尺寸,标签行高与格子行对齐
  const labels = document.createElement("div");
  labels.className = "heatmap-weekdays";
  labels.innerHTML = "<span></span><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span>";
  const scroll = document.createElement("div");
  scroll.className = "heatmap-scroll";
  const months = document.createElement("div");
  months.className = "heatmap-months";
  months.style.gridTemplateColumns = "repeat(" + weekCount + ", var(--heat-cell))";
  const grid = document.createElement("div");
  grid.className = "heatmap-grid";
  grid.style.gridTemplateColumns = "repeat(" + weekCount + ", var(--heat-cell))";
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
    // 未来日期与 0 次提交的历史日期一样显示为 l0 空格子(填充右侧空白)
    const dayStr = dayKey(day);
    const count = counts.get(dayStr) || 0;
    cell.className = "heatmap-cell l" + activityLevel(count, values);
    cell.dataset.date = dayStr; // 重渲染后恢复 tooltip 用
    cell.dataset.count = count;
    cell.style.gridColumn = col;
    cell.style.gridRow = row;
    // 悬停显示当天提交数:自定义 tooltip 跟随鼠标(替代原生 title,即时可靠)
    cell.addEventListener("mouseenter", (e) => showHeatTip(e, dayStr + " · " + count + " 次提交"));
    cell.addEventListener("mousemove", (e) => moveHeatTip(e));
    cell.addEventListener("mouseleave", hideHeatTip);
    grid.appendChild(cell);
  }
  scroll.append(months, grid);
  layout.append(labels, scroll);
  box.appendChild(layout);
  // 重渲染后恢复 tooltip(鼠标仍在格子上时重新显示;不在则收起残留)
  restoreHeatTip();
  // 首轮渲染用外层宽度估算(滚动容器尚未存在),下一帧量真实宽度修正:
  // 必须先记录测量值再决定是否重排——否则 heatScrollW 恒为 0,本分支每次渲染都会
  // 再排队下一帧重排,陷入「每帧整图重建」死循环(滚动卡顿/闪烁的根源)
  if (!heatScrollW) {
    requestAnimationFrame(() => {
      const el = box.querySelector(".heatmap-scroll");
      if (!el || !el.clientWidth) return;
      heatScrollW = el.clientWidth;
      if (Math.abs(el.clientWidth - estW) > 1) renderActivity();
    });
  }
}

// 热力图/环形图悬浮提示:显示对应信息,跟随鼠标;定位锚点为 .dash-activity
function showHeatTip(e, text) {
  const tip = $("heat-tooltip");
  tip.textContent = text;
  tip.classList.remove("hidden");
  moveHeatTip(e);
}
function moveHeatTip(e) {
  const tip = $("heat-tooltip");
  if (!tip || tip.classList.contains("hidden")) return;
  // tooltip 为 position: fixed,直接用视口坐标;出现在鼠标右下方,贴边时翻转到左上方
  const x = e.clientX + 12;
  const y = e.clientY + 12;
  tip.style.left = (x + tip.offsetWidth > window.innerWidth ? e.clientX - tip.offsetWidth - 12 : x) + "px";
  tip.style.top = (y + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 12 : y) + "px";
}
function hideHeatTip() {
  const tip = $("heat-tooltip");
  tip.classList.add("hidden");
}

// 重渲染后恢复 tooltip:重建的元素不会自动重触发 mouseenter,若鼠标仍停留在
// 热力图格子/堆叠色段/图例项/柱状图列上,按最近记录的鼠标位置重新显示。
// 同时兜底:鼠标不在任何提示目标上时,收起残留(解决"非悬停也显示"的问题)
function restoreHeatTip() {
  if (!lastMouse) return;
  const el = document.elementFromPoint(lastMouse.x, lastMouse.y);
  if (!el) { hideHeatTip(); return; }
  const cell = el.closest ? el.closest(".heatmap-cell") : null;
  const seg = el.closest ? el.closest(".cat-stack-seg") : null;
  const item = el.closest ? el.closest(".cat-stack-item") : null;
  const wcol = el.closest ? el.closest(".week-col") : null;
  if (cell) {
    const count = parseInt(cell.dataset.count, 10);
    showHeatTip({ clientX: lastMouse.x, clientY: lastMouse.y },
      cell.dataset.date + " · " + (isNaN(count) ? 0 : count) + " 次提交");
  } else if ((seg && seg.dataset.tip) || (item && item.dataset.tip)) {
    showHeatTip({ clientX: lastMouse.x, clientY: lastMouse.y }, (seg || item).dataset.tip);
  } else if (wcol && wcol.dataset.tip) {
    showHeatTip({ clientX: lastMouse.x, clientY: lastMouse.y }, wcol.dataset.tip);
  } else {
    hideHeatTip();
  }
}

// 全局记录鼠标位置:热力图/条形图/柱状图重渲染(后台 fetch、尺寸变化等)后据此恢复提示
document.addEventListener("mousemove", (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, true);

/* ===== 近7日代码量柱状图 ===== */
const WEEK_DAYS = 7;
let weekVol = { days: [], loaded: false, loading: false, key: "" };

function weekStart() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - (WEEK_DAYS - 1));
  return day;
}

// 后台汇总近7日增删行数(与活跃度同一套缓存策略:同项目集只拉一次)
async function refreshOverviewCode() {
  const paths = repos.map((r) => r.path);
  const key = paths.slice().sort().join("\u001f");
  if (weekVol.loading || (weekVol.loaded && weekVol.key === key)) return;
  weekVol.loading = true;
  weekVol.key = key;
  const start = weekStart();
  try {
    const result = await invoke("repos_code_volume", { repos: paths, since: Math.floor(start.getTime() / 1000) });
    if (weekVol.key === key) {
      weekVol.days = result?.days || [];
      weekVol.loaded = true;
    }
  } catch (_) {
    if (weekVol.key === key) weekVol.loaded = true;
  } finally {
    weekVol.loading = false;
    if (view === "overview") renderWeekBars();
  }
}

// 柱段高度(百分比):按峰值归一化到 100%,不足 1% 但有量时保底 1%(保证可见),零为 0。
// 基于 bar 高度(由 CSS flex 撑满)自动缩放,不依赖像素测量
function segPct(v, max) {
  if (!v || !max) return 0;
  return Math.max(1, Math.round((v / max) * 100));
}

function renderWeekBars() {
  const box = $("week-bars");
  const total = $("week-total");
  if (!box || !total) return;
  const paths = repos.map((r) => r.path);
  if (!paths.length) {
    total.textContent = "";
    box.textContent = "添加项目后显示近7日代码量";
    box.className = "chart-empty";
    return;
  }
  box.className = "";
  box.innerHTML = "";
  const byDate = new Map(weekVol.days.map((d) => [d.date, d]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const names = "日一二三四五六";
  let sumAdd = 0, sumDel = 0, max = 0;
  const rows = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    const e = byDate.get(dayKey(day)) || { add: 0, del: 0 };
    sumAdd += e.add;
    sumDel += e.del;
    max = Math.max(max, e.add + e.del);
    rows.push({ day, add: e.add, del: e.del });
  }
  // 总数:+/- 行数,数字亮色与文字分开(与热力图总数一致的视觉层级)
  if (weekVol.loading) {
    total.textContent = "汇总中…";
  } else {
    total.textContent = "";
    const p = document.createElement("span");
    p.className = "wk-plus";
    p.textContent = "+" + sumAdd;
    const m = document.createElement("span");
    m.className = "wk-minus";
    m.textContent = "-" + sumDel;
    total.append(p, m);
  }
  const wrap = document.createElement("div");
  wrap.className = "week-bars";
  for (const r of rows) {
    const col = document.createElement("div");
    col.className = "week-col" + (r.day.getTime() === today.getTime() ? " today" : "");
    const bar = document.createElement("div");
    bar.className = "week-bar";
    const del = document.createElement("span");
    del.className = "wb-del";
    const add = document.createElement("span");
    add.className = "wb-add";
    // 段高用百分比(基于 bar 高度):bar 由 CSS flex:1 撑满,高度自适应不依赖测量
    del.style.height = segPct(r.del, max) + "%";
    add.style.height = segPct(r.add, max) + "%";
    bar.append(del, add); // 删(红)在上、增(绿)在下,自底向上堆叠
    const label = document.createElement("span");
    label.className = "week-label";
    label.textContent = names[r.day.getDay()];
    col.append(bar, label);
    const tip = (r.day.getMonth() + 1) + "月" + r.day.getDate() + "日 · +" + r.add + " / -" + r.del + " 行";
    col.dataset.tip = tip;
    col.addEventListener("mouseenter", (e) => showHeatTip(e, tip));
    col.addEventListener("mousemove", (e) => moveHeatTip(e));
    col.addEventListener("mouseleave", hideHeatTip);
    wrap.appendChild(col);
  }
  box.appendChild(wrap);
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
  card.addEventListener("click", () => switchRepo(r.path)); // 点卡片空白处进入项目

  // 头部:项目名 | 更多按钮(右上角)(运行状态由操作区的运行/停止按钮体现,不再加徽章)
  const head = document.createElement("div");
  head.className = "run-card-head";
  const name = document.createElement("span");
  name.className = "run-card-name";
  name.textContent = r.name;
  head.append(name);
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

/* ===== 项目类型单条横向堆叠占比图 ===== */
// 分类配色:与分类 Tab 的语义一致,取稳定的低饱和色板;
// 数量最多的分类单独用主题色(accent)突出
const DONUT_COLORS = {
  web: "var(--chart-web)", desktop: "var(--chart-desktop)", mobile: "var(--chart-mobile)", extension: "var(--chart-extension)",
  backend: "var(--chart-backend)", other: "var(--chart-other)",
};
function renderCategoryDonut() {
  const box = $("category-donut");
  if (!box) return;
  box.innerHTML = "";
  if (!repos.length) {
    box.textContent = "添加项目后显示类型分布";
    box.className = "kpi-cat chart-empty"; // 保留卡内嵌基类 kpi-cat,只追加图表态
    return;
  }
  box.className = "kpi-cat";
  // 按 CATEGORIES 顺序汇总,未在列表中的分类(如自定义)归入 other
  const counts = new Map();
  for (const r of repos) counts.set(r.category || "other", (counts.get(r.category || "other") || 0) + 1);
  const rows = CATEGORIES
    .map((c) => ({ id: c.id, label: c.label, n: counts.get(c.id) || 0 }))
    .filter((r) => r.n > 0);
  // 未匹配到标准分类的项目(理论上 CATEGORIES 已覆盖,兜底显示)
  for (const [id, n] of counts) if (n > 0 && !CATEGORIES.some((c) => c.id === id)) rows.push({ id, label: id, n });

  // 数量最多的分类套主题色,其余用分类色板(并列最多时都套主题色)
  const maxN = Math.max(...rows.map((r) => r.n), 0);
  const colorOf = (r) => (r.n === maxN ? "var(--accent)" : (DONUT_COLORS[r.id] || DONUT_COLORS.other));

  const total = repos.length;
  const wrap = document.createElement("div");
  wrap.className = "cat-stack";
  // 单条横向堆叠条:各分类色段首尾相连排成一条线,宽度按占比
  const bar = document.createElement("div");
  bar.className = "cat-stack-bar";
  for (const r of rows) {
    const seg = document.createElement("div");
    seg.className = "cat-stack-seg";
    seg.style.background = colorOf(r);
    seg.style.width = Math.round((r.n / total) * 100) + "%";
    // 悬停即时显示分类信息(复用热力图的自定义 tooltip)
    const tipText = r.label + " · " + r.n + " 个项目 · " + Math.round((r.n / total) * 100) + "%";
    seg.dataset.tip = tipText; // 重渲染后恢复 tooltip 用
    seg.addEventListener("mouseenter", (e) => showHeatTip(e, tipText));
    seg.addEventListener("mousemove", (e) => moveHeatTip(e));
    seg.addEventListener("mouseleave", hideHeatTip);
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  // 下方图例:色块 + 名称 + 数量(数字与热力图等一致的视觉层级)
  const legend = document.createElement("div");
  legend.className = "cat-stack-legend";
  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "cat-stack-item";
    const tipText = r.label + " · " + r.n + " 个项目 · " + Math.round((r.n / total) * 100) + "%";
    item.dataset.tip = tipText;
    item.addEventListener("mouseenter", (e) => showHeatTip(e, tipText));
    item.addEventListener("mousemove", (e) => moveHeatTip(e));
    item.addEventListener("mouseleave", hideHeatTip);
    const dot = document.createElement("span");
    dot.className = "cat-dot";
    dot.style.background = colorOf(r);
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = r.label;
    const n = document.createElement("span");
    n.className = "cat-n";
    n.textContent = r.n;
    item.append(dot, name, n);
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  box.appendChild(wrap);
  restoreHeatTip(); // 重渲染后恢复 tooltip(鼠标停在色段/图例上时重新显示)
}

/* ===== KPI 卡片 ===== */
// KPI 图标使用同一套线性比例,但各自保留明确的 Git/运行语义。
const KPI_ICONS = {
  // 三层仓库堆叠:用硬朗的等距折线表达项目集合。
  total: '<path d="m4.5 7.5 7.5-2.7 7.5 2.7-7.5 2.7-7.5-2.7Z"/><path d="M4.5 7.5v4.8l7.5 2.8 7.5-2.8V7.5"/><path d="M4.5 12.3v4.8l7.5 2.8 7.5-2.8v-4.8"/>',
  // 方角终端 + 命令提示:直接表达正在运行的开发服务。
  run: '<path d="M4 4h16v16H4z"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  // 方形分支节点 + 上行箭头:表达本地分支等待推送。
  push: '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M7 12h4a5 5 0 0 0 5-5V3"/><path d="m13 6 3-3 3 3"/>',
};
function renderKpis() {
  const nPush = repos.filter((r) => r.ahead > 0).length;
  const cards = [
    { icon: "total", v: repos.length, label: "项目数量", color: "var(--accent-bright)", wide: true },
    { icon: "run", v: liveRepos().length, label: "运行中", color: "var(--orange)" },
    { icon: "push", v: nPush, label: "待推送", color: "var(--blue)" },
  ];
  const box = $("dash-cards");
  box.innerHTML = "";
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "kpi-card" + (c.wide ? " kpi-card-wide" : "");
    // 大图标独占左列(主视觉),标签与数字为右列
    const ic = document.createElement("span");
    ic.className = "kpi-ic kpi-ic-" + c.icon;
    ic.setAttribute("aria-hidden", "true");
    ic.style.color = c.color;
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter">' + KPI_ICONS[c.icon] + "</svg>";
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
    // 项目数量卡:上方图标+数字行,下方内嵌项目类型堆叠占比图
    if (c.wide) {
      const top = document.createElement("div");
      top.className = "kpi-top";
      top.append(ic, body);
      card.append(top);
      const catBox = document.createElement("div");
      catBox.id = "category-donut";
      catBox.className = "kpi-cat";
      card.appendChild(catBox);
    } else {
      card.append(ic, body);
    }
    box.appendChild(card);
  }
  // 类型堆叠图(#category-donut)内嵌在「项目数量」卡里,容器随本函数整体销毁重建:
  // 必须随建随填。否则任何只调 renderKpis 的路径(如外部运行探测回调 refreshOverviewRunning)
  // 都会留下一个空容器,图例凭空消失;renderDashboard 的输入快照守卫又会跳过重建,无法恢复
  renderCategoryDonut();
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
    let added = 0;
    for (const path of paths) {
      const result = await invoke("repos_add", { path });
      settings.repos = result.repos;
      if (result.added) added++;
    }
    await loadRepos(); // 总览态自动重渲染图表,侧栏列表同步更新
    refreshOverviewPorts(); // 新项目补充静态端口
    toast(added ? "已添加 " + added + " 个项目" : "所选项目已在列表中", true);
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

  // 首页头部「更多」菜单
  $("btn-dash-more").addEventListener("click", (e) => {
    e.stopPropagation();
    $("dash-more-menu").classList.toggle("hidden");
  });
  // 关闭所有项目:清空仓库列表并回到空态
  $("btn-dash-close-all").addEventListener("click", async () => {
    $("dash-more-menu").classList.add("hidden");
    if (!settings.repos.length) return;
    try {
      await invoke("repos_clear");
      settings.repos = [];
      const { setRepo } = await import("./state.js");
      setRepo(null);
      const { showEmpty } = await import("./panel.js");
      await loadRepos(); // 空列表:侧栏/总览同步
      await showEmpty(false);
      toast("已关闭所有项目", true);
    } catch (e) {
      toast(String(e), false);
    }
  });

  // 图表重建本身会改变内容高度,不能监听它或主滚动区的尺寸。
  // 仅响应明确的窗口/侧栏布局变化,避免滚动时触发重绘回路。
  const refreshChartsForLayout = () => {
    if (view !== "overview") return;
    heatScrollW = 0;
    renderActivity();
    renderCategoryDonut();
  };
  window.addEventListener("resize", refreshChartsForLayout);
  window.addEventListener("dashboard-layout-change", refreshChartsForLayout);
  $("dash-search").addEventListener("input", (e) => {
    dashQuery = e.target.value;
    renderRunCards();
  });
  $("dash-sort").addEventListener("change", (e) => {
    dashSort = e.target.value;
    renderRunCards();
  });
}

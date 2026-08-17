/* 运行服务器:常驻底部面板(识别命令从左往右平铺,点击运行/停止 + 实时日志),
   外部运行端口探测(项目在其他终端/应用启动时显示占用提示) */
import { $, invoke, listen, toast, settings, repo, view, urlPort, urlDisplay } from "./state.js";

// 某仓库自定义运行地址解析出的端口列表(探测外部运行时一并检查)
function customPorts(path) {
  const p = urlPort((settings.run_urls || {})[path]);
  return p ? [p] : [];
}

const RUN_LOG_MAX = 2000; // 单仓库日志最多保留行数,超出裁掉最早的
const RUN_HISTORY_MAX = 8; // 最近使用命令历史最多保留条数(总览页启动仍会记入)

// 「运行服务器」:每个仓库一份日志缓冲 + 运行态,跨仓库切换不丢失
const runLogs = {};   // repo -> [{ cls: "" | "err" | "sys", text }]
const runState = {};  // repo -> Boolean(本应用启动的进程是否运行中)
const runActiveCmd = {}; // repo -> 运行中的命令文本(前端据此定位对应 chip 的运行态)
const extRun = {};    // repo -> [{port, source}] 外部检测到的占用端口
let runCmdOptions = []; // 当前仓库的识别候选[{cmd, source, stoppable}],供平铺展示
let runBusy = false;  // 当前仓库启动/停止进行中,防重复触发

export function openRunPanel() { $("run-panel").classList.remove("closed"); syncRunToggle(); }
export function closeRunPanel() { $("run-panel").classList.add("closed"); syncRunToggle(); }
// 展开/收起切换(标题栏常驻,收起后仍可展开)
export function toggleRunPanel() {
  if ($("run-panel").classList.contains("closed")) openRunPanel();
  else closeRunPanel();
}
// 同步切换按钮的箭头朝向与标题
export function syncRunToggle() {
  const btn = $("btn-run-collapse");
  if (!btn) return;
  const closed = $("run-panel").classList.contains("closed");
  btn.title = closed ? "展开日志面板" : "收起日志面板";
}

// 追加一行日志:skipBuffer=true 时仅渲染 DOM(由 renderRunLog 重建调用)
function appendRunLine(cls, text, skipBuffer) {
  const log = $("run-log");
  if (!log) return;
  if (repo && !skipBuffer) {
    const arr = runLogs[repo] || (runLogs[repo] = []);
    arr.push({ cls, text });
    if (arr.length > RUN_LOG_MAX) arr.splice(0, arr.length - RUN_LOG_MAX);
  }
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  while (log.childElementCount > RUN_LOG_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight; // 自动滚到底
}

// 从当前仓库的缓冲重建日志区(切换仓库时调用);无日志时显示占位提示
function renderRunLog() {
  const log = $("run-log");
  if (!log) return;
  log.textContent = "";
  const lines = (repo && runLogs[repo]) || [];
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "run-log-empty";
    empty.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg><span>暂无运行日志</span>';
    log.appendChild(empty);
    return;
  }
  for (const ln of lines) appendRunLine(ln.cls, ln.text, true);
}

// 运行栏右侧地址:自定义地址优先,其次探测到的 Web 端口(tauri 端口是 WebView 内部资源不显示);
// 点击在浏览器打开,显示形式与总览卡片一致(localhost 只显示端口);
// 无地址时显示「无运行端口」占位(灰色只读),不隐藏
function updateRunUrl() {
  const el = $("run-url");
  if (!el) return;
  const custom = repo ? (settings.run_urls || {})[repo] : null;
  const ports = repo ? (extRun[repo] || []).filter((p) => p.source !== "tauri") : [];
  const u = custom || (ports.length ? "http://localhost:" + ports[0].port : null);
  if (!u) {
    el.textContent = "无运行端口";
    el.classList.add("dim");
    el.classList.remove("hidden");
    el.onclick = null;
    return;
  }
  el.textContent = urlDisplay(u);
  el.classList.remove("hidden", "dim");
  el.onclick = () => invoke("open_url", { url: u });
}

// 复制当前仓库的全部运行日志;没有日志时不复制占位提示
async function copyRunLog() {
  const lines = (repo && runLogs[repo]) || [];
  if (!lines.length) { toast("暂无运行日志", false); return; }
  const text = lines.map((ln) => ln.text).join("\n");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      try {
        input.focus();
        input.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
      } finally {
        input.remove();
      }
    }
    toast("日志已复制", true);
  } catch (_) {
    toast("复制日志失败", false);
  }
}

// 运行态变化后同步侧栏「运行中」绿点(动态 import 断开与 sidebar 的循环依赖)
function syncRunDots() {
  import("./sidebar.js").then(({ updateRepoRunDots }) => updateRepoRunDots()).catch(() => {});
}

// 平铺渲染全部识别命令 chip:空闲=▶+文本;运行中(本应用启动或外部运行)=可停止→⏹+文本 / 不可停止→▶常亮;
// 运行中其他 chip 禁用;外部占用但无法归因到某条命令时全部禁用
function renderRunCmds() {
  const wrap = $("run-cmds");
  if (!wrap) return;
  syncRunDots(); // 运行态重渲染时一并同步侧栏绿点
  updateRunUrl();
  wrap.textContent = "";
  if (!repo) return;
  if (!runCmdOptions.length) {
    const d = document.createElement("span");
    d.className = "run-cmds-empty";
    d.textContent = "未识别到运行命令";
    wrap.appendChild(d);
    return;
  }
  const running = !!runState[repo];
  const active = runActiveCmd[repo] || "";
  const ext = extRun[repo] || [];
  // 外部运行归因(排他):按命令优先级取第一个隐含端口命中被占端口的命令;
  // 单命令项目直接归因。多条命令隐含同一端口时(如 vite.config 端口与 preview
  // 的显式 --port 相同)也只点亮优先级最高的(通常 dev),避免多个 chip 同亮
  const solo = runCmdOptions.length === 1;
  const hitPort = (it) => ext.find((p) => solo || (it.ports || []).includes(p.port));
  const extCmd = !running && ext.length
    ? runCmdOptions.find((it) => hitPort(it)) || null
    : null;
  for (const it of runCmdOptions) {
    const b = document.createElement("button");
    b.className = "run-chip";
    const icon = document.createElement("span");
    icon.className = "run-chip-icon";
    const isActive = running && active === it.cmd;
    const extHit = extCmd === it ? hitPort(it) : null;
    const isOn = isActive || !!extHit;
    const canStop = (isActive && it.stoppable) || !!(extHit && extHit.pid);
    // 可停止命令运行中→停止方块;其余→播放三角
    icon.innerHTML = isOn && canStop
      ? '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
    const t = document.createElement("span");
    t.className = "run-chip-cmd";
    t.textContent = it.cmd;
    b.append(icon, t);
    if (isOn) {
      b.classList.add("running");
      if (isActive && !it.stoppable) b.title = `${it.cmd} 执行中，结束后自动恢复`;
      else if (extHit && !extHit.pid) b.title = `外部运行中，未能确认进程归属，无法在此停止`;
      else b.title = `点击停止 ${it.cmd}` + (extHit ? "（外部运行）" : "");
    } else if (running) {
      b.classList.add("disabled");
      b.title = `请先停止「${active}」`;
    } else if (ext.length) {
      b.classList.add("disabled");
      b.title = `端口 ${ext.map((p) => p.port).join("、")} 已被占用，可能已在外部运行`;
    }
    b.addEventListener("click", () => chipClick(it, extHit));
    wrap.appendChild(b);
  }
}

// 点击命令 chip:空闲→启动;本应用启动的运行中命令→停止(仅可停止命令);
// 外部运行命中→确认归属则停止;其余情况给出提示
async function chipClick(it, extHit) {
  if (!repo || runBusy) return;
  if (runState[repo]) {
    if (runActiveCmd[repo] === it.cmd) {
      if (it.stoppable) await stopActive();
      // 不可停止命令执行中:无停止动作,静默(标题已说明)
    } else {
      toast(`「${runActiveCmd[repo]}」运行中，请先停止`, false);
    }
    return;
  }
  // 外部运行命中:端口进程与项目归属均已确认 → 停止;未确认 → 说明不可停
  if (extHit) {
    if (extHit.pid) {
      runBusy = true;
      try { await stopExternalServer(repo, extHit.port, extHit.pid); }
      finally { runBusy = false; }
    } else {
      toast("未能确认占用进程的归属，无法在此停止", false);
    }
    return;
  }
  const ext = extRun[repo] || [];
  if (ext.length) {
    toast(`端口 ${ext.map((p) => p.port).join("、")} 已被占用，项目可能已在外部运行`, false);
    return;
  }
  await startServer(it.cmd);
}

// 停止当前仓库的运行进程(状态由 server-status 事件回推,这里也主动清一次保证即时反馈)
async function stopActive() {
  if (!repo || runBusy) return;
  runBusy = true;
  try {
    await invoke("server_stop", { repo });
    toast("已停止运行", true);
    runState[repo] = false;
    runActiveCmd[repo] = null;
    renderRunCmds();
  } catch (e) {
    toast(String(e), false);
    renderRunCmds();
  } finally {
    runBusy = false;
  }
}

// 切换/初始化时回填当前仓库的运行命令、日志与运行态
export function syncRunPanel() {
  if (!repo) {
    runCmdOptions = [];
    renderRunCmds();
    renderRunLog();
    return;
  }
  // 智能识别:候选填入平铺栏
  const detectRepo = repo;
  invoke("server_detect", { repo }).then((list) => {
    if (detectRepo !== repo) return; // 已切换仓库,丢弃过期结果
    runCmdOptions = list || [];
    renderRunCmds();
  }).catch(() => {});
  renderRunLog();
  // 本应用启动且运行中的项目:切回时自动展开日志面板(外部运行无日志流,不自动打开)
  if (runState[repo] && $("run-panel").classList.contains("closed")) openRunPanel();
  // 后端确认真实运行态(应用刚启动时进程表为空,这里恢复运行命令以点亮对应 chip)
  const statusRepo = repo;
  invoke("server_status", { repo }).then((s) => {
    if (statusRepo === repo) {
      runState[repo] = !!s.running;
      runActiveCmd[repo] = s.running ? (s.command || null) : null;
      renderRunCmds();
      if (s.running && $("run-panel").classList.contains("closed")) openRunPanel();
    }
  }).catch(() => {});
  // 外部运行检测:端口被占用说明项目已在其他应用/终端启动
  refreshExternalStatus();
}

// 重新探测当前仓库的外部占用端口(端口占用随时变化:外部启动/停止后需刷新)
export function refreshExternalStatus() {
  if (!repo) return;
  const r = repo;
  invoke("server_external_check", { repo, extra: customPorts(r) }).then((ports) => {
    if (r === repo) {
      if ((ports || []).length && !(extRun[repo] || []).length) touchRunLast(repo); // 新检测到运行
      extRun[repo] = ports || []; renderRunCmds();
    }
  }).catch(() => {});
}

/* ===== 总览页运行态查询/写回 ===== */
// 全部运行中的仓库(本应用启动 + 外部检测到的),路径去重合并
export function runningRepos() {
  const keys = new Set([
    ...Object.keys(runState).filter((k) => runState[k]),
    ...Object.keys(extRun).filter((k) => extRun[k] && extRun[k].length),
  ]);
  return [...keys].map((k) => ({ repo: k, self: !!runState[k], ports: (extRun[k] || []).slice() }));
}

// 批量写回外部探测结果(总览页 server_external_check_all 用)
export function setExternalAll(map) {
  for (const [k, v] of Object.entries(map || {})) {
    // 新检测到运行(空 → 非空)视为一次运行,刷新「上次运行」时间
    if ((v || []).length && !(extRun[k] || []).length) touchRunLast(k);
    extRun[k] = v || [];
  }
}

/* ===== 上次运行时间(总览「按上次运行排序」用) =====
   本应用启动成功、检测到外部运行(状态空 → 有端口)时刷新,持久化在 settings.run_last */
function touchRunLast(path) {
  settings.run_last = settings.run_last || {};
  settings.run_last[path] = Date.now();
  invoke("settings_save", { settings }).catch(() => {});
}
export function runLastFor(path) {
  return (settings.run_last || {})[path] || 0;
}

// 供总览卡片使用:探测某仓库的全部识别候选(未缓存,每次调用拉取)
export function detectCommandsFor(path) {
  return invoke("server_detect", { repo: path }).then((list) => list || []).catch(() => []);
}

// 供总览卡片使用:某仓库当前运行中的命令文本(未运行为 null)
export function activeCmdFor(path) {
  return runState[path] ? (runActiveCmd[path] || null) : null;
}

/* ===== 总览页:指定仓库的启停(不经当前仓库与运行面板 UI) ===== */
// 启动:优先用传入命令,否则取已保存值,再否则自动识别候选第一个并保存
export async function startServerFor(path, cmd) {
  if (!path || runState[path]) return;
  const ext = extRun[path] || [];
  if (ext.length) { toast(`端口 ${ext.map((p) => p.port).join("、")} 已被占用，项目可能已在外部运行`, false); return; }
  if (!cmd) cmd = (settings.run_commands[path] || "").trim();
  if (!cmd) {
    try {
      const list = await invoke("server_detect", { repo: path });
      if (list && list.length && list[0].cmd) {
        cmd = list[0].cmd;
        settings.run_commands[path] = cmd;
        invoke("settings_save", { settings }).catch(() => {});
      }
    } catch (_) {}
  }
  if (!cmd) { toast("未识别到运行命令，请进入项目后在运行面板选择", false); return; }
  pushRunHistory(cmd); // 记入最近使用
  try {
    await invoke("server_start", { repo: path, command: cmd });
    runState[path] = true;
    runActiveCmd[path] = cmd;
    syncRunDots(); // 后端启动不发事件,乐观置运行态后立即点亮侧栏绿点
    touchRunLast(path); // 刷新「上次运行」时间
    if (!runLogs[path]) runLogs[path] = [];
    // 后端启动不发事件(仅退出发),总览态需手动刷新图表
    if (view === "overview") import("./dashboard.js").then(({ renderDashboard }) => renderDashboard()).catch(() => {});
    // 端口要等服务起来才监听:延迟探测一次,让总览卡片尽快显示可打开的地址
    setTimeout(() => {
      invoke("server_external_check", { repo: path, extra: customPorts(path) }).then((ports) => {
        extRun[path] = ports || [];
        if (view === "overview") import("./dashboard.js").then(({ renderDashboard }) => renderDashboard()).catch(() => {});
        else if (path === repo) renderRunCmds();
      }).catch(() => {});
    }, 2500);
  } catch (e) { toast(String(e), false); }
}

// 停止:状态由后端 server-status 事件回推,总览图表经监听器自动刷新
export async function stopServerFor(path) {
  if (!path) return;
  try {
    await invoke("server_stop", { repo: path });
    toast("已停止运行", true);
  } catch (e) { toast(String(e), false); }
}

// 停止外部运行的进程(仅当探测时确认了 pid 归属本项目;后端还会二次校验防误杀)
export async function stopExternalServer(path, port, pid) {
  if (!path || !pid) return;
  try {
    await invoke("server_external_stop", { repo: path, port, pid });
    extRun[path] = (extRun[path] || []).filter((p) => p.pid !== pid && p.port !== port);
    if (view === "overview") import("./dashboard.js").then(({ renderDashboard }) => renderDashboard()).catch(() => {});
    else if (path === repo) renderRunCmds();
    toast("已停止运行", true);
  } catch (e) { toast(String(e), false); }
}

// 记录最近使用的运行命令(新→旧,去重,超限裁掉最旧;总览页启动用,运行面板平铺不依赖)
function pushRunHistory(cmd) {
  if (!cmd) return;
  settings.run_history = settings.run_history || [];
  settings.run_history = [cmd, ...settings.run_history.filter((c) => c !== cmd)].slice(0, RUN_HISTORY_MAX);
  invoke("settings_save", { settings }).catch(() => {});
}

// 启动当前仓库的某条识别命令(平铺 chip 点击入口)
export async function startServer(cmd) {
  if (!repo) { toast("请先选择一个项目", false); return; }
  if (!cmd) return;
  if (runState[repo]) { toast("服务器已在运行", true); return; }
  const ext = extRun[repo] || [];
  if (ext.length) { toast(`端口 ${ext.map((p) => p.port).join("、")} 已被占用，项目可能已在外部运行`, false); return; }
  runBusy = true;
  try {
    await invoke("server_start", { repo, command: cmd });
    runState[repo] = true;
    runActiveCmd[repo] = cmd;
    touchRunLast(repo); // 刷新「上次运行」时间
    if (!runLogs[repo]) runLogs[repo] = [];
    appendRunLine("sys", `$ ${cmd}`);
    renderRunCmds();
    // 端口要等服务起来才监听:延迟探测一次,让运行栏尽快显示可打开的端口
    const startedRepo = repo;
    setTimeout(() => {
      invoke("server_external_check", { repo: startedRepo, extra: customPorts(startedRepo) }).then((ports) => {
        extRun[startedRepo] = ports || [];
        if (startedRepo === repo) renderRunCmds();
      }).catch(() => {});
    }, 2500);
  } catch (e) {
    toast(String(e), false);
    renderRunCmds();
  } finally {
    runBusy = false;
  }
}

/* ===== 事件绑定 ===== */
export function bindRunEvents() {
  $("btn-run-collapse").addEventListener("click", toggleRunPanel);
  $("btn-run-copy").addEventListener("click", copyRunLog);

  // 运行日志面板顶部拖拽调整高度,并持久化到设置
  const RUN_H_MIN = 120, RUN_H_MAX = 640;
  let runDragStartY = 0, runDragStartH = 0;
  const onRunDrag = (e) => {
    const viewportMax = Math.max(RUN_H_MIN, window.innerHeight - 80);
    const max = Math.min(RUN_H_MAX, viewportMax);
    const h = Math.min(max, Math.max(RUN_H_MIN, runDragStartH + runDragStartY - e.clientY));
    $("run-panel").style.setProperty("--run-panel-height", h + "px");
  };
  const endRunDrag = () => {
    document.body.classList.remove("resizing-vertical");
    document.removeEventListener("pointermove", onRunDrag);
    const h = Math.round($("run-panel").getBoundingClientRect().height);
    if (Number.isFinite(h)) {
      settings.run_height = h;
      invoke("settings_save", { settings }).catch(() => {});
    }
  };
  $("run-resizer").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const panel = $("run-panel");
    runDragStartY = e.clientY;
    runDragStartH = panel.getBoundingClientRect().height;
    document.body.classList.add("resizing-vertical");
    document.addEventListener("pointermove", onRunDrag);
    document.addEventListener("pointerup", endRunDrag, { once: true });
  });
}

/* ===== 后端事件监听 ===== */
export function initRunListeners() {
  // 运行服务器:逐行日志回推(stdout 普通色 / stderr 红色),仅追加当前仓库
  listen("server-log", (e) => {
    const p = e.payload;
    if (!p || p.repo !== repo) return;
    appendRunLine(p.stream === "err" ? "err" : "", p.line);
  });
  // 运行服务器:启停态变更(进程退出/主动停止时由后端发出),更新 chip 态并提示
  listen("server-status", (e) => {
    const p = e.payload;
    if (!p) return;
    runState[p.repo] = !!p.running;
    if (p.running && p.command) runActiveCmd[p.repo] = p.command;
    else if (!p.running) runActiveCmd[p.repo] = null;
    syncRunDots(); // 任意项目启停(含非当前项目)都要同步侧栏绿点
    if (p.repo === repo) renderRunCmds();
    if (!p.running) {
      // 停止后乐观清空该项目的外部运行记录(启动后探测到的端口就是它自己),
      // 再后台重查:若端口确被其他进程占用会重新探测回来;
      // 不清会导致停止后卡片仍显示运行中,再点停止因旧 pid 失效而报「进程已退出」
      extRun[p.repo] = [];
      const r = p.repo;
      invoke("server_external_check", { repo: r, extra: customPorts(r) }).then((ports) => {
        extRun[r] = ports || [];
        if (view === "overview") import("./dashboard.js").then(({ renderDashboard }) => renderDashboard()).catch(() => {});
        else if (r === repo) renderRunCmds();
      }).catch(() => {});
    }
    // 总览态下进程启停:同步刷新运行中图表(动态 import 断开 dashboard↔run-panel 循环依赖)
    if (view === "overview") {
      import("./dashboard.js").then(({ renderDashboard }) => renderDashboard()).catch(() => {});
    }
    // 仅非主动停止(进程自身退出/崩溃,带退出码)时提示;主动停止由 chip 点击提示
    if (!p.running && p.code !== undefined && p.code !== null) {
      toast(`服务器已停止（退出码 ${p.code}）`, false);
    }
  });
}

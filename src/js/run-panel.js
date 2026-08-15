/* 运行服务器:常驻底部面板(命令输入+启停+日志),多候选命令下拉,
   外部运行端口探测(项目在其他终端/应用启动时显示运行中但不可停止) */
import { $, invoke, listen, toast, setButtonLoading, settings, repo } from "./state.js";

const RUN_LOG_MAX = 2000; // 单仓库日志最多保留行数,超出裁掉最早的

// 「运行服务器」:每个仓库一份日志缓冲 + 运行态,跨仓库切换不丢失
const runLogs = {};   // repo -> [{ cls: "" | "err" | "sys", text }]
const runState = {};  // repo -> Boolean(本应用启动的进程是否运行中)
const extRun = {};    // repo -> [{port, source}] 外部检测到的占用端口
let runCmdOptions = []; // 当前仓库的识别候选[{cmd,source}],供标题栏下拉展示

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

// 从当前仓库的缓冲重建日志区(切换仓库时调用)
function renderRunLog() {
  const log = $("run-log");
  if (!log) return;
  log.textContent = "";
  const lines = (repo && runLogs[repo]) || [];
  for (const ln of lines) appendRunLine(ln.cls, ln.text, true);
}

// 按运行态刷新工具栏按钮、面板圆点与启停按钮文案(自启动 + 外部检测合并展示)
export function syncRunStatus() {
  const selfRunning = !!runState[repo];
  const ext = extRun[repo] || [];
  const extOnly = !selfRunning && ext.length > 0;
  const running = selfRunning || extOnly;
  const btn = $("btn-run");
  if (btn) {
    btn.disabled = !repo;
    btn.classList.toggle("running", running);
    // 融合按钮的整体边框色跟随运行态
    btn.closest(".run-btn-wrap")?.classList.toggle("running", running);
    // 外部运行中的进程不是本应用启动的,不可停止,仅提示
    btn.title = extOnly ? "已在外部运行，请到外部停止" : "运行项目开发服务器（实时日志，可停止）";
  }
  // 子元素仅在非 loading 时更新(loading 时 innerHTML 已被 spinner 替换,元素不存在)
  if (btn && !btn.classList.contains("loading")) {
    $("run-label").textContent = running ? "运行中" : "运行";
    $("btn-run-icon-play").classList.toggle("hidden", running);
    $("btn-run-icon-stop").classList.toggle("hidden", !running);
  }
}

// 切换/初始化时回填当前仓库的运行命令、日志与运行态
export function syncRunPanel() {
  const cmdInput = $("run-cmd");
  $("run-menu").classList.add("hidden");
  if (!repo) {
    if (cmdInput) cmdInput.value = "";
    fillRunCmdOptions([]);
    runCmdOptions = [];
    renderRunLog();
    syncRunStatus();
    return;
  }
  const saved = settings.run_commands[repo];
  if (saved) cmdInput.value = saved;
  else cmdInput.value = "";
  // 智能识别:候选填入下拉;仅作建议回填(不持久化、不覆盖用户正在输入的内容)
  const detectRepo = repo;
  invoke("server_detect", { repo }).then((list) => {
    if (detectRepo !== repo) return; // 已切换仓库,丢弃过期结果
    runCmdOptions = list || [];
    fillRunCmdOptions(runCmdOptions);
    const hasSaved = !!settings.run_commands[repo];
    if (!hasSaved && !$("run-cmd").value && document.activeElement !== $("run-cmd") && runCmdOptions.length) {
      $("run-cmd").value = runCmdOptions[0].cmd;
    }
  }).catch(() => {});
  renderRunLog();
  syncRunStatus();
  // 本应用启动且运行中的项目:切回时自动展开日志面板(外部运行无日志流,不自动打开)
  if (runState[repo] && $("run-panel").classList.contains("closed")) openRunPanel();
  // 后端确认真实运行态(应用刚启动时进程表为空,这里保持查询以应对未来场景)
  const statusRepo = repo;
  invoke("server_status", { repo }).then((s) => {
    if (statusRepo === repo) {
      runState[repo] = !!s;
      syncRunStatus();
      if (s && $("run-panel").classList.contains("closed")) openRunPanel();
    }
  }).catch(() => {});
  // 外部运行检测:端口被占用说明项目已在其他应用/终端启动,按钮同样显示运行中(但不可停止)
  refreshExternalStatus();
}

// 重新探测当前仓库的外部占用端口(端口占用随时变化:外部启动/停止后需刷新)
export function refreshExternalStatus() {
  if (!repo) return;
  const r = repo;
  invoke("server_external_check", { repo }).then((ports) => {
    if (r === repo) { extRun[repo] = ports || []; syncRunStatus(); }
  }).catch(() => {});
}

// 填充运行命令候选下拉(来源标注为 label,命令为 value)
function fillRunCmdOptions(list) {
  const dl = $("run-cmd-options");
  if (!dl) return;
  dl.innerHTML = "";
  for (const it of list || []) {
    const o = document.createElement("option");
    o.value = it.cmd;
    o.label = it.source;
    dl.appendChild(o);
  }
}

// 保存某仓库的运行命令(空则清除)
export function saveRunCommand(value) {
  if (!repo) return;
  const v = (value || "").trim();
  if (v) settings.run_commands[repo] = v;
  else delete settings.run_commands[repo];
  invoke("settings_save", { settings }).catch(() => {});
}

// 启动 / 停止 当前仓库的服务器
async function doRunToggle() {
  if (!repo) { toast("请先选择一个项目", false); return; }
  if (runState[repo]) {
    setButtonLoading($("btn-run"), true, "停止中…");
    try {
      await invoke("server_stop", { repo });
      toast("服务器已停止", true);
    } catch (e) { toast(String(e), false); }
    finally { setButtonLoading($("btn-run"), false); syncRunStatus(); }
    return;
  }
  const ext = extRun[repo] || [];
  if (ext.length) { toast(`已在外部运行（端口 ${ext.map((p) => p.port).join("、")}），请到外部停止`, false); return; }
  await startServer();
}

// 启动服务器:cmd 为空时取输入框值,再空则自动识别候选第一个
export async function startServer(cmd) {
  if (!repo) { toast("请先选择一个项目", false); return; }
  openRunPanel(); // 点击运行自动向上展开日志面板
  if (runState[repo]) { toast("服务器已在运行", true); return; }
  const ext = extRun[repo] || [];
  if (ext.length) { toast(`端口 ${ext.map((p) => p.port).join("、")} 已被占用，项目可能已在外部运行`, false); return; }
  if (!cmd) {
    cmd = ($("run-cmd").value || "").trim();
    if (!cmd) {
      try {
        const list = await invoke("server_detect", { repo });
        if (list && list.length && list[0].cmd) { cmd = list[0].cmd; $("run-cmd").value = cmd; saveRunCommand(cmd); }
      } catch (_) {}
    }
  }
  if (!cmd) { toast("未识别到运行命令，请在运行面板填写", false); $("run-cmd").focus(); return; }
  setButtonLoading($("btn-run"), true, "启动中…");
  try {
    await invoke("server_start", { repo, command: cmd });
    runState[repo] = true;
    if (!runLogs[repo]) runLogs[repo] = [];
    appendRunLine("sys", `$ ${cmd}`);
    syncRunStatus();
    toast("服务器已启动", true);
  } catch (e) {
    toast(String(e), false);
  } finally {
    setButtonLoading($("btn-run"), false);
    syncRunStatus();
  }
}

// 渲染面板内运行命令下拉(已保存命令置顶,其余为识别候选)
function renderRunMenu() {
  const menu = $("run-menu");
  menu.innerHTML = "";
  menu.classList.remove("hidden");
  const saved = repo && settings.run_commands[repo];
  const opts = [...runCmdOptions];
  if (saved && !opts.some((o) => o.cmd === saved)) {
    opts.unshift({ cmd: saved, source: "已保存" });
  }
  if (!opts.length) {
    const d = document.createElement("div");
    d.className = "run-menu-empty";
    d.textContent = "未识别到运行命令，可在运行面板填写";
    menu.appendChild(d);
    return;
  }
  for (const it of opts) {
    const b = document.createElement("button");
    b.className = "run-menu-item";
    b.title = it.cmd;
    const t = document.createElement("span");
    t.className = "run-cmd-text";
    t.textContent = it.cmd;
    const s = document.createElement("span");
    s.className = "run-cmd-src";
    s.textContent = it.source;
    b.append(t, s);
    b.addEventListener("click", () => chooseRunCommand(it.cmd));
    menu.appendChild(b);
  }
}

// 下拉选中某命令:保存 + 直接启动
function chooseRunCommand(cmd) {
  $("run-menu").classList.add("hidden");
  if (!repo) return;
  if (runState[repo]) { toast("服务器运行中，请先停止", false); return; }
  $("run-cmd").value = cmd;
  saveRunCommand(cmd);
  startServer(cmd);
}

/* ===== 事件绑定 ===== */
export function bindRunEvents() {
  $("btn-run").addEventListener("click", doRunToggle);
  // 标题栏运行命令下拉:点击箭头展开候选列表
  $("btn-run-caret").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("run-menu");
    if (menu.classList.contains("hidden")) renderRunMenu();
    else menu.classList.add("hidden");
  });
  $("run-menu").addEventListener("click", (e) => e.stopPropagation());
  $("btn-run-collapse").addEventListener("click", toggleRunPanel);
  // 命令输入:回车/失焦时保存为该仓库的命令(空则清除)
  const saveCmd = () => saveRunCommand($("run-cmd").value);
  $("run-cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCmd(); $("run-cmd").blur(); } });
  $("run-cmd").addEventListener("blur", saveCmd);
}

/* ===== 后端事件监听 ===== */
export function initRunListeners() {
  // 运行服务器:逐行日志回推(stdout 普通色 / stderr 红色),仅追加当前仓库
  listen("server-log", (e) => {
    const p = e.payload;
    if (!p || p.repo !== repo) return;
    appendRunLine(p.stream === "err" ? "err" : "", p.line);
  });
  // 运行服务器:启停态变更(进程退出时由后端发出),更新按钮并提示
  listen("server-status", (e) => {
    const p = e.payload;
    if (!p) return;
    runState[p.repo] = !!p.running;
    if (p.repo === repo) {
      syncRunStatus();
      // 自启动进程退出后端口可能已被外部占用或已释放,重查外部态避免残留误报
      if (!p.running) refreshExternalStatus();
    }
    // 仅非主动停止(进程自身退出/崩溃,带退出码)时提示;主动停止由 doRunToggle 提示
    if (!p.running && p.code !== undefined && p.code !== null) {
      toast(`服务器已停止（退出码 ${p.code}）`, false);
    }
  });
}

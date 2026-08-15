/* 共享状态与通用工具:跨模块读写的变量集中在此,通过 setter 重绑(ES module 的
   import 绑定只读,赋值必须回到声明模块内);对象属性修改无需 setter。 */
export const { invoke } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;

export const $ = (id) => document.getElementById(id);

export const DEFAULT_AI = { base_url: "https://api.deepseek.com", api_key: "", model: "deepseek-v4-flash", lang: "中文", commit_mode: "auto", custom_prompt: "" };
export const STATUS_CHARS = { A: "A", M: "M", D: "D", R: "R", C: "C", U: "?", "?": "?" };

/* ===== 共享可变状态(setter 供跨模块重绑) ===== */
export let settings = { ai: { ...DEFAULT_AI }, last_repo: null, repos: [], run_commands: {} };
export let repos = []; // 侧栏仓库摘要列表
export let repo = null; // 当前仓库路径
export let view = "repo"; // 主区视图:repo(单项目面板) | overview(多仓库总览)
export let lastShipStatus = null; // 最近一次仓库状态,供按钮在 loading 结束后重建
let busy = false;

export function setSettings(v) { settings = v; }
export function setRepos(v) { repos = v; }
export function setRepo(v) { repo = v; }
export function setView(v) { view = v; }
export function setLastShipStatus(v) { lastShipStatus = v; }
export function isBusy() { return busy; }

/* ===== 通用 UI 工具 ===== */
let toastTimer = null;

export function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

export function setBusy(v, text) {
  busy = v;
  $("sb-busy").classList.toggle("hidden", !v);
  if (text) $("sb-busy-text").textContent = text;
}

/* 按钮级加载状态:按钮内显示 spinner + 文案,并隐藏全局忙碌指示 */
export function setButtonLoading(btn, loading, text) {
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

// 命令执行 + 全局忙碌指示 + 结果 toast
export async function runBusy(cmd, args, busyText, okText) {
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

/* ===== 时间格式 ===== */
export function relTime(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 紧凑版相对时间(并排窄列用):刚刚 / 5分前 / 3时前 / 2天前 / 8-01
export function relTimeShort(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + "分前";
  if (s < 86400) return Math.floor(s / 3600) + "时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "天前";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/* ===== 无图标项目的字母头像 ===== */
// 10 种高区分度配色(与主题暗色系协调),按路径哈希稳定分配
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
export function repoAvatarColor(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

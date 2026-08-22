/* 监听当前项目的本地文件变化,并对 Git 状态面板做防抖刷新。 */
import { invoke, listen, repo } from "./state.js";
import { refresh } from "./panel.js";

const REFRESH_DEBOUNCE_MS = 350;
let refreshTimer = null;
let unlisten = null;

export async function bindRepoFileWatcher() {
  unlisten = await listen("repo-files-changed", (event) => {
    if (!repo || event.payload?.repo !== repo) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
  });
  await syncRepoFileWatcher();
}

export async function syncRepoFileWatcher() {
  try {
    await invoke("repo_watch_start", { repo });
  } catch (_) {
    // 监听失败不阻塞 Git 操作;用户仍可通过切换项目或重启刷新状态。
  }
}

export function disposeRepoFileWatcher() {
  if (unlisten) unlisten();
  unlisten = null;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

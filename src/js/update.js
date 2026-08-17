/* 应用内更新:基于 Tauri updater 插件。启动后自动静默检查,也可在设置的「关于与更新」
   手动触发;发现新版本弹窗展示说明,下载(带进度)安装并自动重启。
   插件 IPC 直接用 core invoke 调用(项目零 npm 运行时依赖,不引入插件 JS 包)。 */
import { $, invoke, toast, setButtonLoading } from "./state.js";

let pendingUpdate = null; // check() 返回的更新元数据 { rid, version, currentVersion, body }

async function checkForUpdate(manual) {
  try {
    const u = await invoke("plugin:updater|check");
    if (!u) {
      if (manual) toast("已是最新版本", true);
      return;
    }
    pendingUpdate = u;
    $("update-new-version").textContent = u.version;
    $("update-current-line").textContent = `当前版本 ${u.currentVersion}，可更新到 ${u.version}`;
    const notes = $("update-notes");
    notes.textContent = u.body || "（本次更新暂无说明）";
    notes.scrollTop = 0;
    $("dlg-update").classList.remove("hidden");
  } catch (e) {
    // 静默自动检查失败不打扰(离线/端点未就绪);手动检查才提示原因
    if (manual) toast("检查更新失败：" + e, false);
  }
}

function closeUpdateDialog() {
  $("dlg-update").classList.add("hidden");
  setButtonLoading($("btn-update-install"), false);
}

async function installUpdate() {
  const u = pendingUpdate;
  if (!u) { closeUpdateDialog(); return; }
  const btn = $("btn-update-install");
  setButtonLoading(btn, true, "准备下载…");
  const { Channel } = window.__TAURI__.core;
  const ch = new Channel();
  let total = 0;
  let received = 0;
  ch.onmessage = (ev) => {
    if (ev.event === "Started" && ev.data && ev.data.contentLength) {
      total = ev.data.contentLength;
    } else if (ev.event === "Progress" && ev.data) {
      received += ev.data.chunkLength;
      setButtonLoading(btn, true, total
        ? `下载中 ${Math.min(99, Math.round((received / total) * 100))}%`
        : `下载中 ${(received / 1048576).toFixed(1)} MB`);
    } else if (ev.event === "Finished") {
      setButtonLoading(btn, true, "安装中…");
    }
  };
  try {
    // restartAfterInstall 由插件在装完后自动重启;Windows NSIS 安装器接管时本 await 不会再返回
    await invoke("plugin:updater|download_and_install", {
      rid: u.rid,
      onEvent: ch,
      restartAfterInstall: true,
    });
    setButtonLoading(btn, false);
    toast("更新完成", true);
    closeUpdateDialog();
  } catch (e) {
    setButtonLoading(btn, false);
    toast("更新失败：" + e, false);
  }
}

export function bindUpdateEvents() {
  // 当前版本号只在启动时读一次(运行期间不会变)
  window.__TAURI__.app.getVersion().then((v) => { $("set-app-version").value = v; })
    .catch(() => { $("set-app-version").value = "未知"; });
  $("btn-check-update").addEventListener("click", () => checkForUpdate(true));
  $("btn-update-install").addEventListener("click", installUpdate);
  $("btn-update-cancel").addEventListener("click", closeUpdateDialog);
}

// 启动 3 秒后静默检查:不打断首屏,离线/失败完全无感
export function startAutoUpdateCheck() {
  setTimeout(() => checkForUpdate(false), 3000);
}

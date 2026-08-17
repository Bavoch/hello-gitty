import { createReadStream, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const port = Number.parseInt(process.argv[2] || "1421", 10);
const root = path.resolve(process.argv[3] || ".");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`无效端口：${process.argv[2] || ""}`);
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

/* ===== 热更新:监听文件变更,经 SSE 通知页面整体 reload ===== */
// 注入到 HTML 的小脚本:订阅变更事件,收到即刷新(ES Module 项目无框架,整页刷新即热更新)
const RELOAD_SNIPPET =
  '<script>(function(){var e=new EventSource("/__hr");e.onmessage=function(){e.close();location.reload()};})()</script>';

const reloadClients = new Set(); // 已连接的 SSE 客户端(response)

// 编辑器一次保存常触发多个 fs 事件,合并为一次重载通知
let reloadTimer = null;
function onFileChange() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    for (const client of reloadClients) client.write("data: reload\n\n");
  }, 120);
}

function watchTree() {
  try {
    const w = watch(root, { recursive: true }, onFileChange);
    w.on("error", () => {}); // 监听中断不影响静态服务
    return;
  } catch {
    // 平台不支持 recursive 时退化为逐目录监听(新建子目录不覆盖,可接受)
  }
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop();
    try {
      const w = watch(dir, onFileChange);
      w.on("error", () => {});
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.isDirectory()) dirs.push(path.join(dir, name.name));
      }
    } catch {
      /* 目录消失等竞态:跳过 */
    }
  }
}
watchTree();

function injectReload(html) {
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + RELOAD_SNIPPET : html.slice(0, i) + RELOAD_SNIPPET + html.slice(i);
}

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl || "/", "http://localhost").pathname);
  const relativePath = pathname.replace(/^[/\\]+/, "");
  let target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    if (statSync(target).isDirectory()) target = path.join(target, "index.html");
  } catch {
    return target;
  }
  return target;
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  // 热更新事件流:页面注入脚本的长连接
  if ((request.url || "").split("?")[0] === "/__hr") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(":ok\n\n"); // 先发一条注释,让连接立即建立而非等待首个事件
    reloadClients.add(response);
    request.on("close", () => reloadClients.delete(response));
    return;
  }

  let target;
  try {
    target = resolveRequestPath(request.url);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!target) {
    response.writeHead(403).end();
    return;
  }

  let stats;
  try {
    stats = statSync(target);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!stats.isFile()) {
    response.writeHead(404).end();
    return;
  }

  const type = mimeTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  // HTML 需读全文注入热更新脚本,Content-Length 以注入后的内容为准(HEAD 同样)
  if (type.startsWith("text/html")) {
    let buf;
    try {
      buf = Buffer.from(injectReload(readFileSync(target, "utf8")), "utf8");
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Length": buf.length, "Content-Type": type });
    if (request.method === "HEAD") response.end();
    else response.end(buf);
    return;
  }

  response.writeHead(200, {
    "Content-Length": stats.size,
    "Content-Type": type,
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(target).pipe(response);
  }
});

server.on("error", (error) => {
  console.error(`开发服务器启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`开发服务器已启动 http://127.0.0.1:${port} (热更新已开启)`);
});

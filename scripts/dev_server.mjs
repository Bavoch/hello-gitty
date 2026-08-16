import { createReadStream, statSync } from "node:fs";
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
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

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

  response.writeHead(200, {
    "Content-Length": stats.size,
    "Content-Type": mimeTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream",
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

server.listen(port, "127.0.0.1");

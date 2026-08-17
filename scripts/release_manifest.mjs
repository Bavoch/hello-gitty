/* 发布更新清单:扫描 tauri build 产出的 *.sig 签名文件,按平台归类生成 Tauri
   updater 端点所需的 latest.json(URL 指向本次 Release 的下载地址)。
   用法: node release_manifest.mjs <tag> <owner/repo> <sig目录> <输出文件> [发布说明文件] */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [tag, repo, dir, out, notesFile] = process.argv.slice(2);
if (!tag || !repo || !dir || !out) {
  console.error("用法: node release_manifest.mjs <tag> <owner/repo> <sig目录> <输出文件> [发布说明文件]");
  process.exit(1);
}

// 文件名 → updater 平台键;新平台(如 linux AppImage)在此扩展
function platformOf(artifact) {
  if (artifact.endsWith("-setup.exe")) return "windows-x86_64";
  if (artifact.endsWith(".app.tar.gz") || artifact.endsWith(".AppImage")) {
    const arch = /aarch64|arm64/.test(artifact) ? "aarch64" : "x86_64";
    return `${artifact.endsWith(".AppImage") ? "linux" : "darwin"}-${arch}`;
  }
  return null;
}

const platforms = {};
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".sig")) continue;
  const artifact = name.slice(0, -4); // 被签名的产物文件名
  const platform = platformOf(artifact);
  if (!platform) {
    console.warn(`跳过无法归类的签名: ${name}`);
    continue;
  }
  platforms[platform] = {
    signature: readFileSync(path.join(dir, name), "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`,
  };
}

if (!Object.keys(platforms).length) {
  console.error("未找到任何更新签名(*.sig),无法生成更新清单");
  process.exit(1);
}

const required = ["darwin-x86_64", "darwin-aarch64", "windows-x86_64"];
const missing = required.filter((platform) => !platforms[platform]);
if (missing.length) {
  console.error(`缺少必需的更新平台: ${missing.join(", ")}`);
  process.exit(1);
}

let notes = `Hello Gitty ${tag}`;
if (notesFile) {
  try {
    const body = readFileSync(notesFile, "utf8").trim();
    if (body) notes = body;
  } catch { /* 无说明文件时用默认文案 */ }
}

writeFileSync(out, JSON.stringify({
  version: tag.replace(/^v/, ""),
  notes,
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2) + "\n");
console.log(`已生成 ${out}: ${Object.keys(platforms).join(", ")}`);

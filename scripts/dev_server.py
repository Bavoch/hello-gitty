#!/usr/bin/env python3
"""开发静态服务器:同 python -m http.server,但所有响应带 Cache-Control: no-store,
避免 Tauri webview 磁盘缓存命中旧 css/js(dev 迭代必须永远看到最新文件)。
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1421
DIR = sys.argv[2] if len(sys.argv) > 2 else "."


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # 静默,避免刷屏
        pass


with socketserver.ThreadingTCPServer(("", PORT), NoCacheHandler) as httpd:
    httpd.allow_reuse_address = True  # 端口 TIME_WAIT 时也能立即重新绑定
    httpd.serve_forever()

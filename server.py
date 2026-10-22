#!/usr/bin/env python3

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = "127.0.0.1"
PORT = int(os.getenv("OPENCLAW_HEALTH_PORT", "7680"))


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/health", "/healthz"):
            self.send_error(404)
            return

        body = json.dumps({
            "status": "ok",
            "service": "openclaw-spaces-health",
        }).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[health] " + fmt % args, flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), HealthHandler)
    print(f"[health] Listening on {HOST}:{PORT}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
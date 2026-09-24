#!/usr/bin/env bash
# Serves the site locally. DuckDB-Wasm needs http://, not file://. Every response is
# sent fresh, so an edited module is never replaced by the copy the browser cached.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8890}"
echo "Open http://127.0.0.1:$PORT"
exec python3 - "$PORT" <<'PY'
import http.server
import sys


class Fresh(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        del self.headers["If-Modified-Since"]
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Fresh).serve_forever()
PY

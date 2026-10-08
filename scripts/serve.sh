#!/usr/bin/env bash
# Serves the site locally. DuckDB-Wasm needs http://, not file://. Every response is
# sent fresh, so an edited module is never replaced by the copy the browser cached.
# Range requests are answered too: the geology PMTiles is read a few tiles at a time.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8890}"
echo "Open http://127.0.0.1:$PORT"
exec python3 - "$PORT" <<'PY'
import http.server
import re
import sys
from pathlib import Path


class Fresh(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        del self.headers["If-Modified-Since"]
        return super().send_head()

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        path = Path(self.translate_path(self.path))
        if not match or not path.is_file():
            return super().do_GET()
        size = path.stat().st_size
        start = int(match[1])
        end = min(int(match[2]) if match[2] else size - 1, size - 1)
        if start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with path.open("rb") as file:
            file.seek(start)
            self.wfile.write(file.read(end - start + 1))


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Fresh).serve_forever()
PY

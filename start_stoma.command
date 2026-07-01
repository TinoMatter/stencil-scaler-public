#!/bin/zsh
# One-click start: launches local server and opens browser.
cd "$(dirname "$0")"
PORT=8765

python3 -m http.server "$PORT" >/tmp/stoma_stencils_server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

open "http://127.0.0.1:${PORT}/index.html"

# Keep terminal window alive while server runs.
wait "$SERVER_PID"
#!/bin/bash
# TMMS startup: starts backend (3001) and frontend dev server (5173, exposed).
# The Vite dev server proxies /api to the backend.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Start backend server in background
cd "$ROOT/backend"
node server.js &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Start frontend server (this will be the exposed port)
cd "$ROOT/frontend"
npm run dev

# Cleanup on exit
trap "kill $BACKEND_PID" EXIT

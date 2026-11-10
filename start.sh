#!/usr/bin/env sh
# Spring Lens launcher (macOS / Linux) - no installation needed, only Node.js 18+.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org (LTS) and run this script again."
  exit 1
fi
echo "Starting Spring Lens on http://localhost:7070  (Ctrl+C to stop)"
exec node bin/spring-lens.js serve --open

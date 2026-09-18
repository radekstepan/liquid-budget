#!/bin/sh
# Free a TCP port by terminating its listeners.
#
# The usual squatter is a stale `next start` / `next dev` server: Playwright
# reuses whatever already listens on the e2e port instead of starting fresh
# code, so a leftover server silently poisons the next `yarn e2e` run
# (stale app bundle, dirty test database handle).
#
# Usage: sh scripts/free-port.sh [port]   (default: 3100, the e2e port)
set -eu

PORT="${1:-3100}"
case "$PORT" in
  '' | *[!0-9]*)
    echo "usage: $0 [port]" >&2
    exit 2
    ;;
esac

pids_on_port() {
  lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true
}

PIDS="$(pids_on_port)"
if [ -z "$PIDS" ]; then
  echo "port $PORT is free"
  exit 0
fi

echo "stopping listeners on port $PORT: $PIDS"
# Word-split PIDS on purpose: one PID per line from lsof.
# shellcheck disable=SC2086
kill $PIDS 2>/dev/null || true
sleep 1

LEFT="$(pids_on_port)"
if [ -n "$LEFT" ]; then
  echo "escalating to SIGKILL: $LEFT"
  # shellcheck disable=SC2086
  kill -9 $LEFT 2>/dev/null || true
  sleep 1
fi

LEFT="$(pids_on_port)"
if [ -n "$LEFT" ]; then
  echo "failed to free port $PORT (still held by: $LEFT)" >&2
  exit 1
fi
echo "port $PORT is free"

#!/bin/bash
# Razkindo ERP - Watchdog (auto-restart dev server)
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$PROJECT_DIR/dev.log"

while true; do
  if ! ss -tlnp 2>/dev/null | grep -q ":3000 "; then
    echo "[$(date)] Starting dev server..." >> "$LOG"
    cd "$PROJECT_DIR"
    NODE_OPTIONS="--max-old-space-size=4096" \
      npx next dev -p 3000 --turbopack >> "$LOG" 2>&1 &
    # Wait for it to be ready
    for i in $(seq 1 30); do
      if ss -tlnp 2>/dev/null | grep -q ":3000 "; then
        echo "[$(date)] Dev server ready" >> "$LOG"
        break
      fi
      sleep 1
    done
  fi
  sleep 5
done

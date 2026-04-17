#!/bin/bash
# Razkindo ERP - Dev Server Auto-Restart Daemon
# Keeps the Next.js dev server alive by auto-restarting when it crashes
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$PROJECT_DIR/dev.log"
PIDFILE="$PROJECT_DIR/.next-dev.pid"
MAX_CRASH=5
CRASH_WINDOW=60  # seconds
crash_count=0
crash_start=0

log() {
  echo "[$(date '+%H:%M:%S')] $1" >> "$LOG"
  echo "[$(date '+%H:%M:%S')] $1"
}

cleanup() {
  log "Daemon stopping..."
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill -TERM "$PID" 2>/dev/null
    fi
    rm -f "$PIDFILE"
  fi
  pkill -f "next dev" 2>/dev/null
  exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

while true; do
  log "Starting Next.js dev server (Turbopack)..."
  cd "$PROJECT_DIR"

  NODE_OPTIONS="--max-old-space-size=4096" \
    npx next dev -p 3000 --turbopack >> "$LOG" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PIDFILE"

  # Wait for server to be ready
  READY=false
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 http://localhost:3000 > /dev/null 2>&1; then
      log "Server ready (PID=$SERVER_PID)"
      READY=true
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "Server died during startup"
      break
    fi
  done

  if [ "$READY" = false ]; then
    log "Server failed to start, waiting 5s before retry..."
    fuser -k 3000/tcp 2>/dev/null
    sleep 5
    continue
  fi

  # Monitor server health
  while true; do
    sleep 5

    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "Server process died!"
      fuser -k 3000/tcp 2>/dev/null
      break
    fi

    # Quick health check
    if ! curl -s -m 3 http://localhost:3000 > /dev/null 2>&1; then
      log "Health check failed, server may be unresponsive"
      sleep 5
      if ! curl -s -m 3 http://localhost:3000 > /dev/null 2>&1; then
        log "Server unresponsive, restarting..."
        kill -9 "$SERVER_PID" 2>/dev/null
        fuser -k 3000/tcp 2>/dev/null
        break
      fi
    fi
  done

  # Crash rate limiting
  NOW=$(date +%s)
  if [ $((NOW - crash_start)) -gt $CRASH_WINDOW ]; then
    crash_count=1
    crash_start=$NOW
  else
    crash_count=$((crash_count + 1))
  fi

  if [ $crash_count -ge $MAX_CRASH ]; then
    log "Too many crashes ($crash_count in $CRASH_WINDOW seconds), cooling down for 30s..."
    sleep 30
    crash_count=0
  else
    log "Restarting in 3s... (crash $crash_count/$MAX_CRASH)"
    sleep 3
  fi
done

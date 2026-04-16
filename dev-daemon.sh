#!/bin/bash
# Razkindo ERP - Dev Server Auto-Restart Daemon
# Keeps the Next.js dev server alive by auto-restarting when it crashes
# This is needed because the large codebase can cause OOM during compilation

LOG="/home/z/my-project/dev.log"
PIDFILE="/home/z/my-project/.next-dev.pid"
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
  cd /home/z/my-project
  
  # Clear .next cache on first start only
  if [ ! -f /home/z/my-project/.next/dev/.ready ]; then
    rm -rf .next 2>/dev/null
  fi
  
  NODE_OPTIONS="--max-old-space-size=4096" \
    node node_modules/.bin/next dev -p 3000 --turbopack >> "$LOG" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PIDFILE"
  
  # Wait for server to be ready
  READY=false
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 http://localhost:3000/api/health > /dev/null 2>&1; then
      log "Server ready (PID=$SERVER_PID)"
      touch /home/z/my-project/.next/dev/.ready
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
    if ! curl -s -m 3 http://localhost:3000/api/health > /dev/null 2>&1; then
      log "Health check failed, server may be unresponsive"
      # Give it one more chance
      sleep 5
      if ! curl -s -m 3 http://localhost:3000/api/health > /dev/null 2>&1; then
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

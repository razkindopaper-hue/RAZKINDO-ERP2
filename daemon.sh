#!/bin/bash
# Razkindo ERP - Production Daemon (auto-restart)
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Load environment variables
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

# Start event-queue in background
if ! pgrep -f "event-queue/index" > /dev/null 2>&1; then
  cd "$PROJECT_DIR/mini-services/event-queue"
  bun index.ts >> "$PROJECT_DIR/event-queue.log" 2>&1 &
  cd "$PROJECT_DIR"
  sleep 2
  echo "[$(date)] Event-queue started" >> "$PROJECT_DIR/server-restart.log"
fi

# Start Next.js production server with auto-restart
RESTART_COUNT=0
MAX_RESTARTS=50

while [ $RESTART_COUNT -lt $MAX_RESTARTS ]; do
  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "[$(date)] Starting Next.js (attempt #$RESTART_COUNT)" >> "$PROJECT_DIR/server-restart.log"

  HOSTNAME=0.0.0.0 PORT=3000 NODE_OPTIONS='--max-old-space-size=1536' \
    node .next/standalone/server.js >> "$PROJECT_DIR/dev.log" 2>&1

  EXIT=$?
  echo "[$(date)] Exited with code $EXIT" >> "$PROJECT_DIR/server-restart.log"

  # Don't restart on clean exit
  if [ "$EXIT" -eq 0 ]; then break; fi

  sleep 3
done

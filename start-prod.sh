#!/bin/bash
# Razkindo ERP - Production Start Script
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Load environment variables
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

export NODE_ENV=production
export HOSTNAME=0.0.0.0
export PORT=3000
export NODE_OPTIONS='--max-old-space-size=1536'

echo "=== Razkindo ERP Production Startup ==="

# 1. Event Queue Service
if ! pgrep -f "event-queue/index" > /dev/null 2>&1; then
  echo "[1/2] Starting event-queue service (port 3004)..."
  cd "$PROJECT_DIR/mini-services/event-queue"
  bun index.ts > "$PROJECT_DIR/event-queue.log" 2>&1 &
  EQ_PID=$!
  sleep 3
  if ! kill -0 $EQ_PID 2>/dev/null; then
    echo "[WARN] Event-queue gagal start. Lihat event-queue.log"
  else
    echo "[1/2] Event-queue OK (PID=$EQ_PID)"
  fi
  cd "$PROJECT_DIR"
else
  echo "[1/2] Event-queue already running"
fi

# 2. Next.js Standalone Server
echo "[2/2] Starting Next.js server (port 3000)..."
cd "$PROJECT_DIR"
node .next/standalone/server.js

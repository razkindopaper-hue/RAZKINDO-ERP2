#!/bin/bash
# Razkindo ERP - Keep Server Alive (smart: production if built, dev otherwise)
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# CRITICAL: Override system DATABASE_URL if it points to SQLite (file:)
# System env may have DATABASE_URL=file:/... which breaks Prisma PostgreSQL connection
_ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$_ENV_FILE" ]; then
  _DB_URL=$(grep '^DATABASE_URL=' "$_ENV_FILE" | head -1 | cut -d'=' -f2-)
  _DIRECT_URL=$(grep '^DIRECT_URL=' "$_ENV_FILE" | head -1 | cut -d'=' -f2-)
  if [ -n "$_DB_URL" ] && echo "$_DB_URL" | grep -q '^postgresql://'; then
    export DATABASE_URL="$_DB_URL"
  fi
  if [ -n "$_DIRECT_URL" ] && echo "$_DIRECT_URL" | grep -q '^postgresql://'; then
    export DIRECT_URL="$_DIRECT_URL"
  fi
fi

if ! curl -s -o /dev/null http://localhost:3000 2>/dev/null; then
  echo "[$(date)] Server down, restarting..." >> "$PROJECT_DIR/server-restart.log"
  # Kill any leftover processes
  kill $(lsof -t -i:3000 2>/dev/null) 2>/dev/null
  kill $(lsof -t -i:3004 2>/dev/null) 2>/dev/null
  sleep 1

  # Start event queue
  cd "$PROJECT_DIR/mini-services/event-queue" && bun index.ts >> "$PROJECT_DIR/event-queue.log" 2>&1 &
  sleep 2

  # Start Next.js - prefer production standalone if built
  cd "$PROJECT_DIR"
  if [ -f ".next/standalone/server.js" ]; then
    echo "[$(date)] Starting production standalone server..." >> "$PROJECT_DIR/server-restart.log"
    HOSTNAME=0.0.0.0 PORT=3000 NODE_OPTIONS="--max-old-space-size=1536" \
      node .next/standalone/server.js >> "$PROJECT_DIR/dev.log" 2>&1 &
  else
    echo "[$(date)] Starting dev server (no standalone build found)..." >> "$PROJECT_DIR/server-restart.log"
    HOSTNAME=0.0.0.0 PORT=3000 npx next dev --turbopack >> "$PROJECT_DIR/dev.log" 2>&1 &
  fi

  echo "[$(date)] Server restarted" >> "$PROJECT_DIR/server-restart.log"
fi

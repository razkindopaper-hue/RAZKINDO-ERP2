#!/bin/sh
# =====================================================================
# Razkindo2 ERP - Docker Entrypoint
# Starts Prisma migrations, auto-seeds if empty, Event Queue, Next.js, and Reverse Proxy
#
# Architecture:
#   Port 3000 (Proxy) → /socket.io/* → Event Queue (port 3004)
#                      → everything   → Next.js (port 3001)
#
# This allows Cloudflare Tunnel to work with a single port.
# =====================================================================

echo "============================================"
echo " Razkindo2 ERP - Starting Services"
echo "============================================"

# ---- Run Prisma migrations ----
echo "[Entrypoint] Running Prisma schema push..."
cd /app
npx prisma db push --accept-data-loss 2>&1 || {
  echo "[Entrypoint] WARNING: Prisma db push failed, retrying in 5s..."
  sleep 5
  npx prisma db push --accept-data-loss 2>&1 || {
    echo "[Entrypoint] ERROR: Prisma db push failed. Trying generate first..."
    npx prisma generate
    npx prisma db push --accept-data-loss 2>&1
  }
}
echo "[Entrypoint] Prisma schema push completed."

# ---- Auto-seed if database is empty ----
echo "[Entrypoint] Checking if database needs seed data..."
SEED_CHECK=$(node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.user.count().then(c => { console.log(c); p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null)

if [ "$SEED_CHECK" = "0" ]; then
  echo "[Entrypoint] Database is empty, seeding sample data..."
  # Wait for Next.js to be ready before calling the seed endpoint
  # We'll trigger it via curl after Next.js starts
  NEED_SEED=1
else
  echo "[Entrypoint] Database has $SEED_CHECK user(s), skipping seed."
  NEED_SEED=0
fi

# ---- Start Event Queue Service (background) ----
echo "[Entrypoint] Starting Event Queue on port 3004..."
cd /app/mini-services/event-queue
node index.js &
EVENT_QUEUE_PID=$!
echo "[Entrypoint] Event Queue PID: $EVENT_QUEUE_PID"

# Wait briefly for event queue to start
sleep 2

# ---- Start Next.js App (background, on port 3001) ----
echo "[Entrypoint] Starting Next.js on port 3001..."
cd /app
HOSTNAME=0.0.0.0 PORT=3001 node server.js &
NEXTJS_PID=$!
echo "[Entrypoint] Next.js PID: $NEXTJS_PID"

# Wait for Next.js to start
sleep 5

# ---- Auto-seed via API call if needed ----
if [ "$NEED_SEED" = "1" ]; then
  echo "[Entrypoint] Triggering seed via API..."
  SEED_RESULT=$(curl -s -X POST http://localhost:3001/api/setup/seed 2>/dev/null)
  echo "[Entrypoint] Seed result: $SEED_RESULT"
fi

# ---- Start Single-Port Reverse Proxy (foreground, on port 3000) ----
echo "[Entrypoint] Starting Reverse Proxy on port 3000..."
echo "[Entrypoint] Cloudflare Tunnel compatible: single port for HTTP + WebSocket"
exec node proxy-server.cjs

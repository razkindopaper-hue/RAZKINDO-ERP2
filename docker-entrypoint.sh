#!/bin/sh
# =====================================================================
# Razkindo2 ERP - Docker Entrypoint
# Starts Prisma migrations, Event Queue, Next.js, and Reverse Proxy
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
sleep 3

# ---- Start Single-Port Reverse Proxy (foreground, on port 3000) ----
echo "[Entrypoint] Starting Reverse Proxy on port 3000..."
echo "[Entrypoint] Cloudflare Tunnel compatible: single port for HTTP + WebSocket"
exec node proxy-server.cjs

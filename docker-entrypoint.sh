#!/bin/sh
# =====================================================================
# Razkindo2 ERP - Docker Entrypoint
# Starts both the Event Queue service and the Next.js app
# =====================================================================

echo "============================================"
echo " Razkindo2 ERP - Starting Services"
echo "============================================"

# ---- Start Event Queue Service (background) ----
echo "[Entrypoint] Starting Event Queue on port 3004..."
cd /app/mini-services/event-queue
node index.js &
EVENT_QUEUE_PID=$!
echo "[Entrypoint] Event Queue PID: $EVENT_QUEUE_PID"

# Wait briefly for event queue to start
sleep 2

# ---- Start Next.js App (foreground) ----
echo "[Entrypoint] Starting Next.js on port 3000..."
cd /app
exec node server.js

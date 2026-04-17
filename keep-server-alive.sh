#!/bin/bash
# Check if server is running, restart if not
if ! curl -s -o /dev/null http://localhost:3000 2>/dev/null; then
  echo "[$(date)] Server down, restarting..."
  # Kill any leftover processes
  kill $(lsof -t -i:3000) 2>/dev/null
  kill $(lsof -t -i:3004) 2>/dev/null
  sleep 1
  
  # Start event queue
  cd /home/z/my-project/mini-services/event-queue && bun index.ts >> /home/z/my-project/event-queue.log 2>&1 &
  
  # Start Next.js dev server
  cd /home/z/my-project && HOSTNAME=0.0.0.0 PORT=3000 npx next dev --turbopack >> /home/z/my-project/dev.log 2>&1 &
  
  echo "[$(date)] Server restarted"
fi

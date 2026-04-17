#!/bin/bash
cd /home/z/my-project

# Start event-queue in background
if ! pgrep -f "event-queue/index" > /dev/null 2>&1; then
  cd mini-services/event-queue
  bun index.ts >> /home/z/my-project/event-queue.log 2>&1 &
  cd /home/z/my-project
  sleep 2
  echo "[$(date)] Event-queue started" >> /home/z/my-project/server-restart.log
fi

# Start Next.js production server
RESTART_COUNT=0
MAX_RESTARTS=50

while [ $RESTART_COUNT -lt $MAX_RESTARTS ]; do
  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "[$(date)] Starting Next.js (attempt #$RESTART_COUNT)" >> /home/z/my-project/server-restart.log
  
  HOSTNAME=0.0.0.0 PORT=3000 NODE_OPTIONS='--max-old-space-size=1536' \
    node .next/standalone/server.js >> /home/z/my-project/dev.log 2>&1
  
  EXIT=$?
  echo "[$(date)] Exited with code $EXIT" >> /home/z/my-project/server-restart.log
  
  # Don't restart on clean exit
  if [ "$EXIT" -eq 0 ]; then break; fi
  
  sleep 3
done

#!/bin/bash
cd /home/z/my-project

# Start event-queue if not running
if ! pgrep -f "event-queue" > /dev/null 2>&1; then
  cd mini-services/event-queue
  setsid bun index.ts >> /home/z/my-project/event-queue.log 2>&1 &
  cd /home/z/my-project
  sleep 2
fi

# Start the Next.js server, restart if it dies
RESTART_COUNT=0
while true; do
  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "[$(date)] Starting Next.js server (attempt #$RESTART_COUNT)..." >> /home/z/my-project/server-restart.log
  
  # Run the server and capture its exit code
  HOSTNAME=0.0.0.0 PORT=3000 NODE_OPTIONS='--max-old-space-size=1536' \
    node .next/standalone/server.js >> /home/z/my-project/dev.log 2>&1
  EXIT=$?
  
  echo "[$(date)] Server exited with code $EXIT" >> /home/z/my-project/server-restart.log
  
  # If exit code is 0, it was a clean shutdown - don't restart
  if [ "$EXIT" -eq 0 ]; then
    echo "[$(date)] Clean shutdown, not restarting" >> /home/z/my-project/server-restart.log
    break
  fi
  
  # If too many restarts, slow down
  if [ "$RESTART_COUNT" -gt 10 ]; then
    echo "[$(date)] Too many restarts, waiting 30s..." >> /home/z/my-project/server-restart.log
    sleep 30
  else
    sleep 3
  fi
done

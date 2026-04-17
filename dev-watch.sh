#!/bin/bash
# Razkindo ERP - Dev Watch with Memory Monitoring
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAX_RSS_MB=3000  # Kill and restart if RSS exceeds this

while true; do
  echo "[$(date +%H:%M:%S)] Starting dev server..."
  cd "$PROJECT_DIR"
  NODE_OPTIONS="--max-old-space-size=4096" npx next dev -p 3000 --turbopack &
  SERVER_PID=$!

  # Wait for server to be ready
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 http://localhost:3000 > /dev/null 2>&1; then
      echo "[$(date +%H:%M:%S)] Server ready (PID=$SERVER_PID)"
      break
    fi
    if ! kill -0 $SERVER_PID 2>/dev/null; then
      echo "[$(date +%H:%M:%S)] Server died during startup"
      break
    fi
  done

  # Monitor server
  while true; do
    sleep 10
    if ! kill -0 $SERVER_PID 2>/dev/null; then
      echo "[$(date +%H:%M:%S)] Server process died, restarting..."
      fuser -k 3000/tcp 2>/dev/null
      sleep 3
      break
    fi

    # Check memory
    RSS=$(ps -p $SERVER_PID -o rss= 2>/dev/null | tr -d ' ')
    if [ -n "$RSS" ]; then
      RSS_MB=$((RSS / 1024))
      if [ $RSS_MB -gt $MAX_RSS_MB ]; then
        echo "[$(date +%H:%M:%S)] RSS=${RSS_MB}MB exceeds limit, restarting..."
        kill -9 $SERVER_PID 2>/dev/null
        fuser -k 3000/tcp 2>/dev/null
        sleep 3
        break
      fi
    fi
  done
done

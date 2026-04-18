#!/bin/bash
# =====================================================================
# Quick Start: Expose Razkindo2 ERP via Cloudflare Tunnel
# =====================================================================
# This script starts a free Cloudflare Tunnel without needing a domain.
# You'll get a public HTTPS URL like: https://xxxx-xxxx.trycloudflare.com
#
# Prerequisites:
#   1. Docker running with ERP: docker compose up -d
#   2. Install cloudflared: brew install cloudflared
#
# Usage:
#   bash cloudflare/start-tunnel.sh
# =====================================================================

echo "🚀 Starting Cloudflare Tunnel for Razkindo2 ERP..."
echo ""
echo "📌 Make sure Docker is running first:"
echo "   cd ~/razkindo2-erp && docker compose up -d"
echo ""

# Create a temporary cloudflared config with both services
TUNNEL_CONFIG=$(cat <<'EOF'
tunnel: auto
ingress:
  # WebSocket/Socket.io connections → event-queue (port 8181)
  - path: "^/socket\\.io/.*"
    service: http://localhost:8181

  # All other traffic → Next.js (port 8180)
  - service: http://localhost:8180
EOF
)

CONFIG_FILE="/tmp/cf-razkindo-config.yml"
echo "$TUNNEL_CONFIG" > "$CONFIG_FILE"

echo "📝 Config saved to $CONFIG_FILE"
echo ""

# Start tunnel using the config
cloudflared tunnel --config "$CONFIG_FILE" --url http://localhost:8180 2>&1 | tee /tmp/cf-tunnel.log &

TUNNEL_PID=$!

echo ""
echo "⏳ Waiting for tunnel URL..."
sleep 5

# Extract the tunnel URL from logs
TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf-tunnel.log | head -1)

if [ -n "$TUNNEL_URL" ]; then
  echo ""
  echo "✅ Tunnel is LIVE!"
  echo ""
  echo "🌐 Public URL: $TUNNEL_URL"
  echo ""
  echo "⚠️  IMPORTANT — Update your .env file with these values:"
  echo ""
  echo "   NEXTAUTH_URL=$TUNNEL_URL"
  echo "   CORS_ORIGINS=$TUNNEL_URL"
  echo ""
  echo "   Then restart Docker:"
  echo "   docker compose down && docker compose up -d"
  echo ""
  echo "🛑 To stop tunnel: kill $TUNNEL_PID"
else
  echo "⏳ Tunnel starting... Check /tmp/cf-tunnel.log for URL"
  echo "   tail -f /tmp/cf-tunnel.log"
fi

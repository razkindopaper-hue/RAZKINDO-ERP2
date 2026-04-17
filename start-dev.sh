#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
export NODE_OPTIONS="--max-old-space-size=4096"
exec npx next dev -p 3000 --turbopack

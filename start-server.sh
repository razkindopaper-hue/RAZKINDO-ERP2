#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
HOSTNAME=0.0.0.0 PORT=3000 npx next dev --turbopack

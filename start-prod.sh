#!/bin/bash
cd /home/z/my-project
PORT=3000 NODE_OPTIONS='--max-old-space-size=768' npx next start -p 3000 2>&1

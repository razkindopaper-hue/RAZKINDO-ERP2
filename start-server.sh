#!/bin/bash
cd /home/z/my-project
fuser -k 3000/tcp 2>/dev/null
sleep 1
rm -rf .next
exec node --max-old-space-size=4096 node_modules/.bin/next dev -p 3000 --turbopack > /home/z/my-project/dev.log 2>&1

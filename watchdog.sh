#!/bin/bash
# Keep-alive watchdog for the Beyond Borders English Academy app.
# Checks http://localhost:3000/ and (re)starts the server when needed.
set -u
APP_DIR="$HOME/workspace/beyond-borders-academy"
LOG="/tmp/academy.log"

healthy() {
  [ "$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' http://localhost:3000/ 2>/dev/null)" = "200" ]
}

if healthy; then
  echo "academy app healthy"
  exit 0
fi

# Post-migration the app requires Postgres; without DATABASE_URL it cannot run
# locally. Stay quiet (exit 0) so the cron doesn't report a false failure.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "academy app awaiting DATABASE_URL (Postgres migration in progress); skipping restart"
  exit 0
fi

echo "academy app not responding; restarting..."
# Stop leftovers (never match this script itself: its cmdline has no "app.js")
for pid in $(pgrep -f "beyond-borders-academy/app.js" 2>/dev/null); do
  kill "$pid" 2>/dev/null
done
sleep 2
cd "$APP_DIR" || { echo "app dir missing"; exit 1; }
# node needs a writable HOME for npm cache; HOME is already set
nohup env PORT=3000 node app.js >>"$LOG" 2>&1 &
disown 2>/dev/null
sleep 5
if healthy; then
  echo "academy app restarted OK"
  exit 0
else
  echo "academy app FAILED to restart; see $LOG"
  exit 1
fi

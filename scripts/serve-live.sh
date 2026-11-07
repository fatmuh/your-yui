#!/usr/bin/env bash
# Supervised production runner (bugfix: opaque 502 at auth login).
#
# The served server used to run as a bare `node src/server/index.ts`: when the
# process died — silently, as happened on 2026-11-07 with no OOM/oomd/kernel
# trace and no crash output — every request behind the reverse proxy answered
# 502 until a manual restart. This script (re)starts the server, records every
# exit with its code and uptime to the log, and restarts automatically with a
# small backoff after a fast crash.
#
# Usage: bash scripts/serve-live.sh
# Env:   LOG_FILE      log target           (default /tmp/yui-server.log)
#        ENV_FILE      env file for node    (default .env)
#        BACKOFF_S     wait after fast crash (default 10)
#        LOCK_FILE     supervisor lock      (default /tmp/yui-serve-live.lock)

set -u

cd "$(dirname "$0")/.." || exit 1

LOG_FILE="${LOG_FILE:-/tmp/yui-server.log}"
ENV_FILE="${ENV_FILE:-.env}"
FAST_CRASH_S=5
BACKOFF_S="${BACKOFF_S:-10}"

if [ ! -f "$ENV_FILE" ]; then
  echo "serve-live: missing env file $ENV_FILE (expected APP_ENCRYPTION_KEY, PORT, DATA_DIR)" >&2
  exit 1
fi
if [ ! -d dist ]; then
  echo "serve-live: warning: no dist/ build yet — run 'npm run build' to serve the client shell" >&2
fi

# One supervisor at a time: the advisory flock exits a second start instead of
# letting it race the first for the port.
LOCK_FILE="${LOCK_FILE:-/tmp/yui-serve-live.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "serve-live: another supervisor holds $LOCK_FILE — not starting a second one." >&2
  exit 1
fi

# Refuse to run alongside a server someone left running unsupervised; two
# servers would fight over the port and the loser would look like a crash loop.
if pgrep -f 'node .*src/server/index\.ts' >/dev/null 2>&1; then
  echo "serve-live: a server process is already running — stop it before starting the supervisor." >&2
  exit 1
fi

child_pid=0
shutdown() {
  if [ "$child_pid" -ne 0 ]; then
    kill "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  echo "[$(date -Is)] serve-live: supervisor stopped" >>"$LOG_FILE"
  exit 0
}
trap shutdown TERM INT

echo "[$(date -Is)] serve-live: supervisor starting (log: $LOG_FILE)" >>"$LOG_FILE"
while true; do
  started_at=$(date +%s)
  node --env-file="$ENV_FILE" src/server/index.ts >>"$LOG_FILE" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  ran_for=$(( $(date +%s) - started_at ))
  child_pid=0
  echo "[$(date -Is)] serve-live: server exited code=$exit_code after ${ran_for}s" >>"$LOG_FILE"
  # The sleeps run in the background and are reaped via `wait` so a trapped
  # TERM/INT interrupts the pause immediately — bash defers a trap handler
  # until the foreground command ends, and only `wait` is interruptible.
  if [ "$ran_for" -lt "$FAST_CRASH_S" ]; then
    echo "[$(date -Is)] serve-live: fast crash — waiting ${BACKOFF_S}s before restarting" >>"$LOG_FILE"
    sleep "$BACKOFF_S" &
  else
    sleep 2 &
  fi
  wait $!
done

#!/bin/sh

# LaunchAgent entry point. The guard owns eligibility, locking, and daily state;
# it invokes the production pipeline only when execution is suitable.
set -eu

RUNTIME_DIR='/Users/jin/.local/share/follow-builders/runtime'
NODE_BIN='/usr/local/bin/node'

if [ ! -x "$NODE_BIN" ] || [ ! -f "$RUNTIME_DIR/scripts/scheduling-guard.js" ]; then
  printf '%s\n' 'eligibility status=guard_error' >&2
  exit 1
fi

exec "$NODE_BIN" "$RUNTIME_DIR/scripts/scheduling-guard.js"

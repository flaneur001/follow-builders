#!/bin/sh

# Local production entry point for launchd. It deliberately produces no Lark
# traffic until the complete digest has been generated and validated.
set -eu

umask 077

RUNTIME_DIR='/Users/jin/.local/share/follow-builders/runtime'
USER_DIR='/Users/jin/.follow-builders'
ENV_PATH="$USER_DIR/.env"
CONFIG_PATH="$USER_DIR/config.json"
NODE_BIN='/usr/local/bin/node'

fail_environment() {
  printf '%s\n' 'stage=environment_config status=failure failure=invalid' >&2
  printf '%s\n' 'daily_digest status=failure' >&2
  exit 1
}

printf '%s\n' 'stage=environment_config status=started' >&2
[ -x "$NODE_BIN" ] || fail_environment
[ -d "$RUNTIME_DIR" ] || fail_environment
[ -f "$ENV_PATH" ] || fail_environment
[ -f "$CONFIG_PATH" ] || fail_environment

cd "$RUNTIME_DIR" || fail_environment

DIGEST_FILE="$(/usr/bin/mktemp /private/tmp/follow-builders-digest.XXXXXX 2>/dev/null)" || fail_environment
RUN_LOG_FILE="$(/usr/bin/mktemp /private/tmp/follow-builders-run.XXXXXX 2>/dev/null)" || {
  /bin/rm -f "$DIGEST_FILE"
  fail_environment
}
cleanup() {
  /bin/rm -f "$DIGEST_FILE" "$RUN_LOG_FILE"
}
trap cleanup EXIT HUP INT TERM

# The local .env is user-owned trusted configuration. Export it so both the
# generator and delivery process receive the same credentials without putting
# secrets in this repository or the LaunchAgent plist.
set -a
if ! . "$ENV_PATH" 2>"$RUN_LOG_FILE"; then
  fail_environment
fi
set +a

[ -n "${DEEPSEEK_API_KEY:-}" ] || fail_environment
[ -n "${LARK_WEBHOOK_URL:-}" ] || fail_environment

# Preserve the established proxy settings for source fetching, DeepSeek, and
# Lark. Set after .env so a local env file cannot accidentally disable them.
export HTTP_PROXY='http://127.0.0.1:9674'
export HTTPS_PROXY='http://127.0.0.1:9674'
export NODE_USE_ENV_PROXY='1'
export DIGEST_PIPELINE="${DIGEST_PIPELINE:-one-pass}"

# Refuse to run before any network request unless delivery is explicitly Lark.
"$NODE_BIN" --input-type=module --eval '
  import { readFile } from "node:fs/promises";
  const config = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (config?.delivery?.method !== "lark") {
    throw new Error("config.json must set delivery.method to lark for the daily production runner");
  }
' "$CONFIG_PATH" >"$RUN_LOG_FILE" 2>&1 || fail_environment
printf '%s\n' 'stage=environment_config status=ok' >&2

# generate-digest.js performs prepare -> DeepSeek generation -> validation. Its
# stdout is only the validated final digest. Allow-listed operational markers
# use fd 3; all ordinary stderr remains private and is deleted during cleanup.
if ! FOLLOW_BUILDERS_DIAGNOSTIC_FD=3 "$NODE_BIN" "$RUNTIME_DIR/scripts/generate-digest.js" \
  3>&2 >"$DIGEST_FILE" 2>"$RUN_LOG_FILE"; then
  printf '%s\n' 'daily_digest status=failure' >&2
  exit 1
fi
[ -s "$DIGEST_FILE" ] || {
  printf '%s\n' 'stage=generation status=failure failure=empty_output' >&2
  printf '%s\n' 'daily_digest status=failure' >&2
  exit 1
}

# This is intentionally the first and only delivery invocation. No prepared
# data, progress status, or failed/partial model output reaches Lark.
printf '%s\n' 'stage=delivery status=started' >&2
if ! "$NODE_BIN" "$RUNTIME_DIR/scripts/deliver.js" --file "$DIGEST_FILE" >"$RUN_LOG_FILE" 2>&1; then
  printf '%s\n' 'stage=delivery status=failure failure=lark_request' >&2
  printf '%s\n' 'daily_digest status=failure' >&2
  exit 1
fi
printf '%s\n' 'stage=delivery status=ok' >&2
printf '%s\n' 'daily_digest status=success' >&2

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

fail() {
  printf '%s\n' "daily digest failed: $*" >&2
  exit 1
}

[ -x "$NODE_BIN" ] || fail "Node.js is not executable at $NODE_BIN"
[ -d "$RUNTIME_DIR" ] || fail "production runtime directory is missing"
[ -f "$ENV_PATH" ] || fail "local environment file is missing"
[ -f "$CONFIG_PATH" ] || fail "local configuration file is missing"

cd "$RUNTIME_DIR" || fail "could not enter production runtime directory"

# The local .env is user-owned trusted configuration. Export it so both the
# generator and delivery process receive the same credentials without putting
# secrets in this repository or the LaunchAgent plist.
set -a
. "$ENV_PATH"
set +a

: "${DEEPSEEK_API_KEY:?daily digest failed: DEEPSEEK_API_KEY is missing}"
: "${LARK_WEBHOOK_URL:?daily digest failed: LARK_WEBHOOK_URL is missing}"

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
' "$CONFIG_PATH" || fail "local configuration is not valid for Lark delivery"

DIGEST_FILE="$(/usr/bin/mktemp /private/tmp/follow-builders-digest.XXXXXX)" || fail "could not create private digest file"
RUN_LOG_FILE="$(/usr/bin/mktemp /private/tmp/follow-builders-run.XXXXXX)" || {
  /bin/rm -f "$DIGEST_FILE"
  fail "could not create private run log"
}
cleanup() {
  /bin/rm -f "$DIGEST_FILE" "$RUN_LOG_FILE"
}
trap cleanup EXIT HUP INT TERM

# generate-digest.js performs prepare -> DeepSeek generation -> validation. Its
# stdout is only the validated final digest. Its diagnostics are kept private:
# an upstream API response or partial model output must never reach launchd logs.
if ! "$NODE_BIN" "$RUNTIME_DIR/scripts/generate-digest.js" >"$DIGEST_FILE" 2>"$RUN_LOG_FILE"; then
  fail "digest generation or validation failed"
fi
[ -s "$DIGEST_FILE" ] || fail "generator produced no final digest"

# This is intentionally the first and only delivery invocation. No prepared
# data, progress status, or failed/partial model output reaches Lark.
if ! "$NODE_BIN" "$RUNTIME_DIR/scripts/deliver.js" --file "$DIGEST_FILE" >"$RUN_LOG_FILE" 2>&1; then
  fail "Lark delivery failed"
fi
printf '%s\n' 'daily digest completed'

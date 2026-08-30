#!/bin/sh

# Install a minimal production runtime from a committed Git revision.
set -eu

umask 077

SOURCE_REPO='/Users/jin/Documents/Codex/follow-builders'
RUNTIME_PARENT='/Users/jin/.local/share/follow-builders'
RUNTIME_DIR="$RUNTIME_PARENT/runtime"
NODE_BIN='/usr/local/bin/node'
NPM_BIN='/usr/local/bin/npm'

fail() {
  printf '%s\n' "runtime install failed: $*" >&2
  exit 1
}

[ -x "$NODE_BIN" ] || fail "Node.js is not executable at $NODE_BIN"
[ -x "$NPM_BIN" ] || fail "npm is not executable at $NPM_BIN"
[ "$#" -eq 1 ] || fail "usage: install-runtime.sh <commit>"

REVISION="$1"
COMMIT="$(/usr/bin/git -C "$SOURCE_REPO" rev-parse --verify "$REVISION^{commit}")" || fail "revision is not a commit"

/bin/mkdir -p "$RUNTIME_PARENT"
STAGING_DIR="$(/usr/bin/mktemp -d "$RUNTIME_PARENT/.runtime-staging.XXXXXX")" || fail "could not create staging directory"
cleanup() {
  /bin/rm -rf "$STAGING_DIR"
}
trap cleanup EXIT HUP INT TERM

# This explicit manifest is the complete repository payload required by the
# daily production path. git archive ignores all working-tree modifications.
ARCHIVE_PATH="$STAGING_DIR/runtime.tar"
/usr/bin/git -C "$SOURCE_REPO" archive -o "$ARCHIVE_PATH" "$COMMIT" -- \
  scripts/prepare-digest.js \
  scripts/generate-digest.js \
  scripts/deliver.js \
  scripts/run-daily-digest.sh \
  scripts/package.json \
  scripts/package-lock.json \
  prompts/summarize-podcast.md \
  prompts/summarize-tweets.md \
  prompts/summarize-blogs.md \
  prompts/digest-intro.md \
  prompts/translate.md
/usr/bin/tar -x -f "$ARCHIVE_PATH" -C "$STAGING_DIR"
/bin/rm -f "$ARCHIVE_PATH"

"$NPM_BIN" ci --prefix "$STAGING_DIR/scripts" --omit=dev --ignore-scripts
/bin/chmod 700 "$STAGING_DIR/scripts/run-daily-digest.sh"
printf '%s\n' "$COMMIT" >"$STAGING_DIR/.runtime-version"

PREVIOUS_DIR="$RUNTIME_PARENT/.runtime-previous"
/bin/rm -rf "$PREVIOUS_DIR"
if [ -e "$RUNTIME_DIR" ]; then
  /bin/mv "$RUNTIME_DIR" "$PREVIOUS_DIR"
fi
if ! /bin/mv "$STAGING_DIR" "$RUNTIME_DIR"; then
  if [ -e "$PREVIOUS_DIR" ]; then
    /bin/mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
  fi
  fail "could not activate staged runtime"
fi
/bin/rm -rf "$PREVIOUS_DIR"
printf '%s\n' "installed runtime commit $COMMIT"

# Local daily digest LaunchAgent

The prepared LaunchAgent is [`com.followbuilders.daily-digest.plist`](com.followbuilders.daily-digest.plist).
Phase 3A deliberately does **not** copy, load, bootstrap, or run it.

## Runtime deployment

The LaunchAgent executes a minimal runtime snapshot outside macOS-protected
Documents directories:

```text
/Users/jin/.local/share/follow-builders/runtime
```

After committing deployment changes, refresh that snapshot from a specific
commit with:

```sh
scripts/install-runtime.sh <commit>
```

The installer uses an explicit file manifest and `git archive`, so uncommitted
working-tree changes, `.git`, tests, examples, feeds, and local secrets are not
copied. It installs locked production dependencies in the staged snapshot and
then replaces the runtime directory. `.runtime-version` records the deployed
commit. Local secrets and configuration remain only under
`/Users/jin/.follow-builders`.

The runner writes only fixed operational stage markers to launchd stderr. Raw
provider diagnostics and delivery output stay in a private temporary file that
is removed on every exit; generated Digest content is never written to logs.

The LaunchAgent retains its 08:00 calendar trigger and also performs a local
eligibility check every 30 minutes. The interval does not wake a sleeping Mac.
After 08:00, production runs only when the console session is active, the wake
is user-triggered, the display is powered, the DeepSeek endpoint is reachable
through the local proxy, no other run holds the lock, and today's terminal state
is absent.

Scheduling state is stored under `/Users/jin/.follow-builders`:

- `daily-digest.lock/` is a short-lived process lock removed after every run.
- `daily-success.json` contains only a local date and terminal status: `success` after
  validated Lark delivery, or `skipped` when that date is explicitly suppressed.
  Either status blocks that date only; failed and ineligible attempts write neither.

Ineligible and failed attempts never create daily state. After delivery succeeds,
the `success` state is written atomically so later triggers skip that day.

## LaunchAgent installation

Copy the plist to this per-user location, then load it in the logged-in user's
launchd domain:

```text
/Users/jin/Library/LaunchAgents/com.followbuilders.daily-digest.plist
```

The plist starts the runtime runner with absolute paths and a fixed runtime
working directory.
The runner itself reads only these local files:

```text
/Users/jin/.follow-builders/.env
/Users/jin/.follow-builders/config.json
```

No secret appears in the plist or repository. The runner exports the established
`HTTP_PROXY`, `HTTPS_PROXY`, and `NODE_USE_ENV_PROXY` values after loading `.env`.
It defaults `DIGEST_PIPELINE` to `one-pass`; setting that variable to `two-stage`
remains the explicit optional override.

## Schedule and macOS behavior

`StartCalendarInterval` has only `Hour = 8` and `Minute = 0`, so it requests one
run every day at 08:00 in the Mac's current system timezone. There is no
per-job timezone key or custom timezone layer. This Mac's `/etc/localtime`
currently resolves to `Asia/Shanghai`, so the configured time is 08:00
Asia/Shanghai while that system timezone remains selected.

The local `launchd.plist(5)` manual states that `StartCalendarInterval` runs the
job when the computer next wakes if it was asleep at the scheduled time; multiple
elapsed calendar events are coalesced into one wake-time run. A powered-off Mac
cannot run a LaunchAgent, and `StartCalendarInterval` has no documented
power-on catch-up behavior: a run missed while powered off is skipped. No
missed-run compensation is configured here.

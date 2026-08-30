# Local daily digest LaunchAgent

The prepared LaunchAgent is [`com.followbuilders.daily-digest.plist`](com.followbuilders.daily-digest.plist).
Phase 3A deliberately does **not** copy, load, bootstrap, or run it.

## Intended installation (Phase 3B)

Copy the plist to this per-user location, then load it in the logged-in user's
launchd domain:

```text
/Users/jin/Library/LaunchAgents/com.followbuilders.daily-digest.plist
```

The plist starts the runner with absolute paths and a fixed working directory.
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

# Survive daemon restarts and reruns

Delivery stopped silently on Jacob's machine on 2026-10-06 and 2026-10-07. This plan records what broke and the stack of PRs that fixes it.

## What happened

- **Idle delivery died in long-lived Pi sessions.** `PremindDaemonClient.request()` only settled on a socket `error`, and the Pi extension set no request timeout. When a daemon exited mid-request, the request never settled. The Pi status poll guards against overlap with `statusPollInFlight`, so that one lost request stopped every later poll. Delivery at `turn_end` still worked, so reminders arrived only after the next user message. `premind_status` showed idle sessions with dozens of pending reminders.
- **A daemon start storm.** Between 00:14 and 00:34 UTC on 2026-10-07, about 70 daemons started. Startup took 2 to 20 seconds under contention. A new daemon deletes the socket when a 250 ms probe fails (`IpcServer.listen`), and the launcher gives up waiting after about 6 seconds, so clients kept starting daemons that stole each other's socket. Two survived, both bound to `premind.sock`, and both polling GitHub. The storm also pegged the CPU, and Jacob force-quit the daemons, which lost more in-flight requests.
- **A rerun's repeat failure was dropped.** Check events use `check.<kind>:<name>:<headSha>` as the dedupe key, and `pr_events` inserts with `INSERT OR IGNORE`. A job that failed, was rerun, and failed again on the same commit produced no event.
- **Noise from grouped and duplicate checks.** Group keys end in the group size, so a later group of the same size is dropped and a group of a different size is re-announced. When a superseded run and the current run both report a check name, the representative check is chosen in arbitrary order, which flaps between states.

Sleep and Wi-Fi were ruled out for the observed misses. GitHub requests also have no timeout, though, so a request stuck across a network change can stall polling for every PR.

## Stack

Each PR is reviewable and revertible on its own. Order is by impact.

1. **Daemon requests cannot hang.** Give every client request a hard deadline and fail it when the daemon closes the connection without replying. Do not retry timeouts, since a busy daemon is alive. Treat a Pi status poll that runs past `STATUS_POLL_STALE_MS` as abandoned.
2. **One daemon at a time.** Never delete a socket whose daemon is alive but slow. Make clients wait for a starting daemon instead of launching another. A daemon that loses the socket exits before any startup work.
3. **Rerun-aware check events.** Key check events by check-run ID, key groups by their members, and prefer the newest run when names collide.
4. **GitHub request timeouts.** Bound every GitHub request and the `gh auth token` lookup, so one stuck request fails into the existing backoff.
5. **Delivery diagnostics.** Log daemon PIDs, report idle-poll health and duplicate daemons in doctor output, and keep tests out of the real state directory.

## Harness checklist

| Change | Pi | OpenCode | Claude | Codex |
|---|---|---|---|---|
| Client deadline and close handling | shared client | shared client | own client in `plugin-claude/bin/lib.mjs` already handles both | shared client |
| Stale status-poll recovery | extension | idle poll uses the shared client, now bounded | hook processes are short-lived | hook processes are short-lived |
| Single daemon | shared startup | shared startup | bundled daemon copy | bundled daemon copy |
| Check event keys, GitHub timeouts | daemon | daemon | daemon | daemon |

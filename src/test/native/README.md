# Native test infrastructure

Run `npm run test:native:infra` with Node 22.13+ and installed repository dependencies.
Infrastructure tests do not need agent binaries, provider keys, or GitHub credentials.

- `sandbox.ts`: isolated HOME/config/workspace/state and short socket paths; explicit
  environment allowlist, never copies personal configuration or credentials.
- `process.ts`: real subprocess supervision, bounded output/deadlines, graceful and
  forced process-group shutdown. Output assertions fail if the process has died.
- `ipc.ts`: real newline-framed Unix socket exchange with a whole-operation deadline
  and response size limit. Negative controls cover invalid JSON, EOF and timeouts.
- `daemon.ts`: unmodified production daemon source with real sockets and SQLite.
  Its fixture `gh` exits without authentication or network access. This is not an
  upstream-update fixture or a packaged-agent test.
- `jsonl.ts`: bounded LF-only host RPC, correlated responses, future-event listeners,
  final-output draining, and explicit malformed/truncated/dead-host failures.
- `provider.ts`: loopback OpenAI-compatible SSE fixture. Receipts require the exact
  marker in model-visible message content; metadata/tool schemas cannot satisfy it.

## Installed Pi transport smoke

With actual Pi on PATH and its required Node version (22.19+), run:

```sh
node --import tsx --test src/test/native/pi-smoke.native.ts
```

This lane fails rather than skips when Pi is missing. It disables discovered
extensions, skills, templates, themes, MCP and context files; uses isolated config,
sessions and an explicit credential-free loopback model; waits for `agent_settled`;
and closes stdin for orderly shutdown. It restarts the actual host with the saved
session file and verifies restored context through the next real model request.

The marker in this transport control is deliberately supplied by a user prompt.
**It does not prove Premind reminder delivery.** No production integration is loaded
in this smoke yet. `pi.ts` accepts an explicit extension path for the subsequent
packed-integration scenario. The smoke remains separate from infrastructure tests;
host version pinning and CI wiring are still pending.

## Evidence boundaries

| Harness | Native evidence at this layer | Still missing |
| --- | --- | --- |
| Pi | Actual RPC/model transport, native persistence and process resume | Packed Premind, upstream updates, handoff/cursors, lifecycle/fault matrix |
| Claude Code | None | Native driver and scenarios |
| OpenCode | None | Native driver and scenarios |
| Codex | None | Native driver and scenarios |

Daemon tests bootstrap all four host protocol identities and check compatibility
and restart persistence. Legacy IPC requests are labelled test controls. They are
not actual native-host execution, lifecycle callbacks, reminder consumption,
reconnection, or delivery confirmation. No native host pass, skip, or unsupported
exception is inferred from those tests. See
`docs/plans/native-agent-lifecycle-harness.md` for remaining proof obligations.

Every fixture owns cleanup before fallible startup and stops processes before
removing state. Diagnostic capture is bounded. Subsequent scenarios must replace
only external services with fixtures, load packed production integrations, and
observe a fresh reminder marker in the real model request before accepting its
conditioned receipt. A daemon handoff acknowledgement alone is insufficient.

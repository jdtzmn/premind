# Native test infrastructure

Run `npm run test:native:infra` with Node 22.13+ and installed repository dependencies.
These tests do not need agent binaries, provider keys, or GitHub credentials.

- `sandbox.ts`: isolated HOME/config/workspace/state and short socket paths; explicit
  environment allowlist, never copies personal configuration or credentials.
- `process.ts`: real subprocess supervision, bounded output/deadlines, graceful and
  forced process-group shutdown. Output assertions fail if the process has died.
- `ipc.ts`: real newline-framed Unix socket exchange with a whole-operation deadline
  and response size limit. Negative controls cover invalid JSON, EOF and timeouts.
- `daemon.ts`: launches the unmodified production daemon source entrypoint with real
  sockets and SQLite. A fixture `gh` executable exits without authentication or
  network access. This is not an upstream-update fixture or a packaged-agent test.

The daemon tests bootstrap each of Pi, Claude Code, OpenCode and Codex as protocol
host identities. They exercise daemon-side compatibility and restart persistence,
**not** actual native host execution, lifecycle callbacks, reminder consumption,
reconnection, or delivery confirmation. Legacy requests in the persistence test
are explicitly labelled test controls, not substitutes for integration tools.

All four native host drivers and their lifecycle scenarios remain unimplemented at
this layer. No native host pass, skip, or unsupported exception is inferred from
these infrastructure tests. See `docs/plans/native-agent-lifecycle-harness.md` for
the stack and the evidence needed before claiming native coverage.

Every fixture owns its sandbox and subprocesses. Tests stop processes before
removing state. Startup failures terminate the child before surfacing diagnostics;
the supervisor bounds captured output. Subsequent delivery scenarios must replace
only external services with scripted fixtures, load packed production integrations,
and prove a unique reminder marker reached the real model request before accepting
a marker-dependent receipt.

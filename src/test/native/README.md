# Native test infrastructure

## Fast infrastructure checks

Run `npm run test:native:infra` with Node 22.13+ and repository dependencies.
These tests need neither agent binaries nor provider/GitHub credentials.

- `sandbox.ts`: isolated HOME/config/workspace/state, short sockets and an explicit
  environment allowlist. Personal configuration and credentials are never copied.
- `process.ts`: bounded subprocess output, readiness deadlines and process-group cleanup.
- `ipc.ts`: real Unix socket framing, deadlines and response limits.
- `daemon.ts`: production daemon source, sockets and SQLite; bootstrap identity and
  restart persistence. Its `gh` shim deliberately cannot authenticate.
- `jsonl.ts`: bounded host RPC, correlated responses, future-event listeners and
  explicit malformed/truncated/dead-host failures.
- `provider.ts`: external OpenAI-compatible SSE fixture. Receipts require the marker
  in model-visible text; tool schemas, metadata and credentials cannot satisfy it.
- `github.ts`: external GitHub API and credential fixture. A child-only fetch preload
  redirects `api.github.com` to loopback and rejects other origins. Production daemon
  policy, watcher, diffing, storage, handoff and host lifecycle code remain unchanged.

## Installed Pi transport smoke

With actual Pi on PATH and Node 22.19+:

```sh
node --import tsx --test src/test/native/pi-smoke.native.ts
```

Missing Pi fails rather than skips. The driver disables discovered extensions,
skills, templates, themes, MCP and context files; uses isolated configuration and a
credential-free local model; waits for `agent_settled`; and closes stdin for orderly
shutdown. The smoke restarts the host with its saved session and checks restored
context in a real model request. Its marker intentionally comes from a user prompt:
this control does **not** prove Premind reminder delivery.

## Packed Premind explicit-delivery baseline

Provide an absolute path to an extracted `npm pack` artifact with dependencies
installed. Do not point at the source checkout. With Pi on PATH:

```sh
PREMIND_NATIVE_PACKAGE=/absolute/path/to/extracted/package \
  node --import tsx --test src/test/native/pi-package.native.ts
```

The scenario loads the packed Pi extension and bundled daemon. A real Pi model/tool
turn subscribes to the fixture PR; the first snapshot establishes a negative control.
Only then does the external GitHub fixture publish a fresh unique comment marker.
No user prompt, tool argument or schema supplies that marker. After the next real
upstream poll, the public `/premind:deliver` command crosses the delivery boundary.

Assertions require a marker-conditioned assistant receipt from an actual model
request, the persisted production event, a covering subscription cursor and a
confirmed handoff settlement. Production Pi acknowledges host enqueue, not model
consumption: this test observes consumption separately and does not establish that
acknowledgement occurs after consumption or globally exactly-once delivery.

An earlier autonomous-idle attempt timed out without a receipt; its cause is not yet
established. The passing explicit-delivery scenario is **not** evidence that idle
delivery works. Keep an autonomous-idle regression separate rather than quietly
claiming this command-boundary test covers it.

Native lanes are separate from infrastructure checks. Reproducible package
preparation, pinned host installation, CI wiring and lifecycle/fault scenarios remain.
Use a fresh marker for every new delivery: a historical receipt or reminder cannot
prove a later delivery after a lifecycle transition.

## Coverage boundaries

| Harness | Native scenarios at this layer | Still missing |
| --- | --- | --- |
| Pi | RPC/model transport and native resume control; packed explicit delivery | Autonomous idle, packed resume, child/switch/reload, fault matrix and CI |
| Claude Code | None | Native driver and scenarios |
| OpenCode | None | Native driver and scenarios |
| Codex | None | Native driver and scenarios |

Report execution outcomes separately from scenario existence. Bootstrap identities
in daemon tests are not native four-host coverage. Missing hosts are not skips
converted to passes or unsupported exceptions. See
`docs/plans/native-agent-lifecycle-harness.md` for remaining proof obligations.

Fixtures own cleanup before fallible startup, stop processes before removing state,
and bound diagnostics. Model/GitHub fixtures replace external services only; no
handwritten lifecycle callback or alternate daemon router proves native behavior.

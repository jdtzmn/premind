# Shared session recovery: host-evidence gate

## Status (2026-10-17)

**Blocked: do not enable automatic recovery across the four adapters.**

The implementation plan's phase-1 prerequisite has not been demonstrated. This
is not permission to skip Claude/Codex, add a harness exception, or ship Pi-only
recovery. It also does not prove that safe recovery is impossible: a supported
per-request handshake still needs investigation and native-host validation.

The draft implementation contains only safe groundwork:

- Structured daemon errors separated from actual socket failures in the shared
  TypeScript client and Claude transport. Application errors cannot initiate
  reconnect/session replay merely because they carry a `code` property.
- An adapter-independent, **unwired** shared recovery controller with one bounded
  retry, single-flight attachment, late-failure revision checks, invalidation,
  and a control-operation allowlist. Its adapter contract requires verified
  current incarnation and daemon-side mutation fencing; it does not provide them.
- Unit/socket regressions and the reviewed implementation plan.

**The original Pi subscribe bug is not fixed by this groundwork.** No adapter
uses the new controller, and no daemon tombstone/generation protocol or Claude
shared-runtime export for recovery has been implemented yet.

## Per-harness coverage and evidence

| Harness | Verified current mechanism | Missing proof / implementation gate |
| --- | --- | --- |
| Pi | Live extension context and sessionManager identity; the isolated regression reproduces successful attach followed by `SESSION_NOT_FOUND` on subscribe. Existing adapter suite passes. | Daemon-side lifecycle/deletion fencing and controller integration remain unimplemented. Do not enable independently of the other hosts. |
| OpenCode | Existing `withReattach` and primary-session filtering; existing reattach tests pass. | Preserve idle/delivery behavior while replacing its local retry policy only after shared authority is implemented. |
| Claude Code | Hook/environment session correlation is supported in the documented limited modes, but MCP retains its launch ID and may outlive the session. | No demonstrated hook-to-MCP incarnation binding; no local Claude executable for a real supported-host experiment. A file marked active is insufficient. |
| Codex | Opaque reusable local handle plus active daemon session resolution; pinned upstream hooks attach thread metadata. | Thread ID is not incarnation authority. Local Codex is 0.146.0, below the repo live-contract minimum 0.155.1; current live fixture also needs an interactive TTY and does not test MCP incarnation. |

## Contract findings

An independent read-only investigation inspected repository fixtures and upstream
contracts. Native launch/incarnation experiments were **not** run in this
checkout. The following sources explain why existing identity correlation is not
proof of the stronger recovery authority required by the plan:

### Claude Code

- [Environment reference](https://code.claude.com/docs/en/env-vars#variables):
  stdio MCP subprocesses retain their original `CLAUDE_CODE_SESSION_ID`; they
  are long-lived and can outlive the session that spawned them. `/clear` updates
  hook/shell identity without necessarily updating an existing MCP environment.
  Explicit-ID resume differs from `--continue` or resume without an explicit ID.
- `CLAUDE_PID` is documented for hook/shell commands, not as an immutable MCP
  launch token. `CLAUDE_ENV_FILE` affects subsequent shell commands; it cannot
  update an already-running MCP process's environment. No secret env files were
  read during this investigation.
- [Hook reference](https://code.claude.com/docs/en/hooks#sessionstart): hook JSON
  supplies a session ID, not a demonstrated incarnation ID. Startup lifecycle
  MCP-tool hooks cannot be assumed available before the MCP client is ready.
- `plugin-claude/live/session-id-contract.mjs` covers fresh and explicit-ID resume
  correlation, not stale MCP retention, crash-without-End, same-process session
  transitions, or launch ownership.

### Codex

- [Hook contract](https://developers.openai.com/codex/hooks): session ID identifies
  the thread. MCP-tool hooks require an existing connection; SessionStart may
  precede readiness, and SessionEnd does not supply an MCP-tool cleanup handshake.
- [MCP contract](https://developers.openai.com/codex/mcp): supports local and remote
  execution. A common local ancestor process therefore cannot be assumed for
  every supported topology.
- Pinned upstream [hook MCP executor at rust-v0.155.1](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/hook_mcp_executor.rs)
  inserts `_meta.threadId`, but thread identity survives resume and is not a
  demonstrated incarnation token.
- Pinned upstream [command runner](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/hooks/src/engine/command_runner.rs)
  uses a shell/session environment snapshot and detaches Unix command hooks.
  Immediate PPID/process-group identity must not be equated with host authority.
- `src/codex/session-binding.ts` deliberately reuses a handle for same-ID resume.
  Reading the latest binding cannot authorize an old MCP process to adopt a new
  incarnation. `scripts/validate-codex-live-contract.mjs` requires >=0.155.1 and
  currently covers hook boundaries, not the required hook/MCP launch binding.

Upstream web documentation is mutable. Revalidate exact host versions and pinned
source before implementation; the repository's earlier fresh/resume correlation
check does not establish the stronger new contract.

## Required next experiment

Extend the existing opt-in native live fixtures, using authenticated supported
Claude and interactive Codex >=0.155.1:

1. Temporary command hooks capture Start/Prompt/End and a minimal stdio MCP
   exposes a no-op binding-proof tool. Capture only identity digests, event/source,
   random MCP launch nonce, native process-start identities, and ordering counters.
   Never log credentials, environments, command lines, prompts, or transcripts.
2. Validate fresh, explicit/no-ID resume, continue, clear, compact, two same-cwd
   sessions, MCP restart, delayed Start, same-ID successor with old MCP retained,
   and host crash without End. Also test shared app-server/multiple-thread and
   remote-executor cases rather than assume one OS process per thread.
3. If using OS ancestry as evidence, prove its relationship to actual session
   incarnations and use native start identity resistant to PID reuse. A timestamp,
   PID, process group, or active file alone is not enough. A live common ancestor
   still does not distinguish multiple incarnations in one host process.
4. Replay the observed topology through deterministic installed-Node subprocess
   tests with delayed IPC, but do not present synthetic parents as native-host
   contract proof.

## Candidate handshake, not yet approved or proven

A supported PreToolUse hook may be able to authorize **one operation**, rather
than grant a persistent stale MCP process authority over a session. Both hosts'
current hook contracts describe input rewriting. Investigate whether a trusted
hook can inject a daemon-issued single-use capability bound to lifecycle
generation, authority epoch, exact operation/arguments, request identity, and the
intended receiving MCP challenge/launch. Do not assume that connection binding
or native rewriting behavior exists merely because updatedInput is documented.

The daemon would consume the ticket transactionally and reject it after End,
delete, crash, or successor generation. Ordinary user approval must remain intact;
a rewrite must not silently introduce an allow decision. Missing evidence fails
closed with actionable guidance.

This is a design spike, not an implemented alternative. If plain plugins cannot
support the handshake, an explicitly launched supervising wrapper/SDK integration
could convey a nonce before startup, but that changes the product's launch
contract and requires user approval. Do not impose that workflow silently.

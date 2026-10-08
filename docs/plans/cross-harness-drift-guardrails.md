# Cross-Harness Drift Guardrails

## Goal

Make it impossible to ship a user-facing Premind change to only some of the
supported coding agents without an explicit, reviewed, user-approved reason.
The supported harnesses are **Pi, Claude Code, OpenCode, and Codex**.

PR #76 shows how drift gets through today: pause/resume shipped Pi-only, and
neither contract test objected. Writing the rule down is not enough; tests must
fail when a harness falls behind.

## Drift found while planning

A quick inspection found more than the pause/resume gap:

- **Codex is missing from both registries.** `premindHarnesses` in
  `src/shared/command-capabilities.ts` lists only Pi, Claude, and OpenCode.
  `ADAPTER_DRIVERS` in `src/test/harness/adapters/index.ts`, which the PR-update
  fan-out test iterates, also omits Codex. Codex is a shipped, documented
  plugin (`plugins/premind`, `plugins/codex/premind`, `src/codex/`).
- **Codex uses a stale name.** It exposes `premind_activate_worktree`; the
  other harnesses renamed it to `premind_set_active_checkout`.
- **Codex lacks doctor, deliver, enable, and disable tools.**
- **"Adapter-specific" needs no justification.** The existing check only asks
  for an exception reason on `common` capabilities, so `prune` (Pi-only) and
  PR #76's pause/resume passed without one.

This PR records the existing Codex gaps as visible deferred exceptions (see 1).
Closing them is follow-up work, sequenced below.

## 1. Capability contract: names, parameters, and harness completeness

`src/shared/command-capabilities.ts` stays the single source of truth.

- **Add Codex.** Add `codex` to `premindHarnesses` and a Codex surface to every
  capability. Codex exposes MCP tools and skills but no slash commands, so its
  command surfaces get an `unsupported` exception. Collect the real Codex
  surface from `codexMcpTools` in the contract test, as the other adapters
  already do.
- **One exception rule for every capability.** Remove the `common`-only
  shortcut. Any harness surface that is missing or renamed relative to the
  canonical surface needs an exception, whatever the classification. Each
  exception has a kind:
  - `unsupported`: the host cannot provide it (for example, Codex has no
    slash commands).
  - `deferred`: the host could provide it but doesn't yet. Each `deferred`
    entry must name a tracking issue or PR.

  The generated `docs/command-capabilities.md` lists every `deferred` gap in
  its own section, so open gaps stay visible.
- **Parameter contract.** Declare each canonical tool's parameters (name, type,
  required). The contract test normalizes each adapter's real schema:
  - Pi: TypeBox schema
  - OpenCode: zod args
  - Claude: JSON `inputSchema`
  - Codex: JSON `inputSchema`

  It then compares each against the declaration. Host-injected parameters,
  such as Codex's required `sessionHandle`, must be declared per harness. This
  would have caught a `confirmGlobal` mismatch between adapters.
- **Harness completeness.** Assert that these three lists name the same set of
  harnesses:
  - `premindHarnesses`
  - the `ADAPTER_DRIVERS` keys
  - the skill generator's host list in `scripts/generate-premind-skills.ts`

  Adding a host to one without the others fails CI.

## 2. Shared behavioral scenarios across every harness

Extend the existing router-backed adapter harness (`src/test/harness/`). Today
it proves one persisted PR update reaches each adapter.

- **Add a Codex driver** built on `runCodexLifecycle` against the real
  `Router`, and add Codex to `ADAPTER_DRIVERS`. The existing fan-out and
  late-arrival suites then cover Codex too.
- **Let drivers invoke controls.** Add `invoke(capabilityId, args)` to
  `AdapterDriver`. It calls the adapter's real tool or command, resolved
  through the capability registry. Add `reload()`, which replays that host's
  real reload or restart event sequence. Each driver documents where its
  sequence comes from, such as the host docs.
- **Capability scenarios.** Write each scenario once and run it through every
  driver against a real `StateStore`. Initial set:
  - status reports the session
  - subscribe and unsubscribe change subscriptions
  - set-active-checkout binds the worktree
  - deliver hands off pending reminders
  - global enable and disable toggle the daemon-wide switch. PR #76 then adds
    the scenario that an unconfirmed call is refused with no daemon call.
- **Coverage meta-test.** Every capability must have at least one scenario for
  each harness where it has a surface. A harness can be skipped only via its
  declared capability exception.

## 3. Shared agent-facing wording

Agents choose tools from their descriptions, so a description that drifts is
behavioral drift.

- Add a canonical description to each capability in the registry, including
  refusal and result text where a capability has them. PR #76's
  `src/shared/global-control.ts` folds into this when it rebases.
- Assert that each adapter's real tool description and refusal text match the
  canonical wording. The Claude MCP server is plain JavaScript and cannot
  import TypeScript, so it keeps its own copy, and the test compares that copy
  against the canonical text.
- Skills are already generated from the registry and the Codex MCP catalog
  (#73), so they inherit this.

## 4. Always-loaded rule and planning requirement

- Add a **Supported harnesses** section to the repository `AGENTS.md`:
  - list all four harnesses;
  - require every user-facing change to cover them;
  - allow skipping one only with explicit user approval, recorded as a
    capability exception;
  - require every plan in `docs/plans/` to include a per-harness coverage
    table.
- Update the agent-local `update-command-capabilities` project skill (outside
  the repo). Cover all four harnesses, the scenario requirement, and the
  lifecycle checklist PR #76 exposed:
  - Does reload or restart recreate the session?
  - Does every delivery path honor session state?
  - Does reconnecting re-register the session as active?

## Sequencing

1. **This PR.** Make the guardrails pass with today's gaps declared as
   visible `deferred` exceptions.
2. **PR #76.** Rebase on this PR. Pause/resume must then cover all four
   harnesses, with no deferred exception unless the user approves one. Fix the
   reload blocker and add a pause-survives-reload scenario for every driver.
3. **Codex parity follow-up.** Resolve the `premind_activate_worktree` name and
   add Codex doctor, deliver, enable, and disable. Remove each `deferred`
   exception as its gap closes.
4. **Deferred: live lifecycle validation.** Add real-host reload checks to
   the existing live-validation scripts once the mocked scenarios exist.

## Per-harness coverage

| Change | Pi | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- | --- |
| Registry surface and parameter contract | ✅ | ✅ | ✅ | ✅ (added) |
| Fan-out and capability scenario driver | ✅ | ✅ | ✅ | ✅ (new driver) |
| Wording contract | ✅ | ✅ (mirrored copy) | ✅ | ✅ |

## Verification

Run the command-capability, contract, fan-out, and capability-scenario tests,
plus `bun run check` and `bun run test:skills`. Then confirm that each
guardrail fails as expected by temporarily:

- removing a Codex tool;
- marking a capability adapter-specific without a reason;
- changing one adapter's parameter or description;
- dropping a driver from `ADAPTER_DRIVERS`.

## Implementation notes

- **A third exception kind, `host-naming`.** Some surfaces exist under a
  host-specific name rather than being missing: Claude's MCP tools omit the
  `premind_` prefix, and OpenCode keeps its hyphenated commands. These are
  recorded as `host-naming` so `unsupported` keeps meaning "cannot exist".
- **Every gap is tracked in #77.** That covers the Codex gaps, the existing
  OpenCode and Claude command gaps, `prune`, and the `writePolicy` parameter
  missing from OpenCode and Codex.
- **Scenarios exercise model tools.** Slash commands stay covered by the name
  contract and adapter-local tests, because Claude's commands are prompt files
  and Codex has none, so neither can be executed in a harness.
- **Drivers can be excused from shared scenarios with typed exceptions.**
  Adding Codex to the fan-out showed that it hands off one reminder batch per
  lifecycle boundary instead of bundling them. Its driver records this as a
  `deferred` `bundlesPendingBatches` exception (#77), and the late-arrival
  test checks successive delivery for Codex instead.
- **Canonical guidance comes from the registry.** Each capability's
  `toolGuidance` is the source:
  - Pi, OpenCode, and Codex build their tool descriptions from it.
  - The Claude MCP server keeps its own copy, which the contract test checks.

# Issue 45: Command Capability Parity

## Goal

Make Premind's user-facing command capabilities explicit across Pi, Claude Code, and OpenCode so adapter changes cannot silently create or remove support.

## Decisions

- `/premind:deliver` is the canonical user command in every harness.
- Claude implements `deliver` as a boundary trigger: the command ends its turn and the existing `Stop` hook performs the normal atomic claim, injection, and continuation acknowledgement.
- `/premind:doctor` is a common diagnostic command; Pi and OpenCode gain it rather than treating Claude's command as an exception.
- `status`, `doctor`, `deliver`, global `enable`/`disable`, active-checkout selection, and subscription management are common semantic capabilities.
- Command and tool exposure may differ only when the capability contract records an intentional reason.
- `prune` remains a Pi-specific administrative command.
- Existing Pi `flush` and OpenCode `send-now` names remain temporary compatibility aliases while `deliver` becomes canonical.

## Architecture

Add a type-checked, declarative capability registry under `src/shared/`. It records canonical capability IDs, scope, classification, harness-visible command and tool names, and explicit exceptions.

The registry is a test and documentation contract, not a shared runtime dispatcher. Each adapter continues to own its lifecycle, privacy, and delivery implementation. Contract tests inspect actual registrations for Pi, Claude Code, and OpenCode and compare them with the registry.

## Phases

### 1. Capability contract and drift gate

- Add the registry and registry validation tests.
- Add a cross-adapter inventory test for actual commands and tools.
- Record the current surface before changing behavior.

### 2. Canonical delivery command

- Add `/premind:deliver` to all three harnesses.
- Add model-callable delivery tools where they can safely perform delivery.
- Keep Pi `/premind:flush` and OpenCode `/premind-send-now` as deprecated aliases.
- Make Claude's command a no-op turn whose `Stop` hook uses the existing handoff state machine.

### 3. Doctor parity

- Add `/premind:doctor` and a diagnostic tool to Pi.
- Add `/premind-doctor` or the platform-equivalent canonical registration to OpenCode, backed by its existing probe implementation.
- Strengthen Claude's probe output to match its documented diagnostic contract.

### 4. Remaining common controls

- Add Pi enable/disable commands and tools.
- Record intentional command-surface differences for active-checkout and subscription operations while requiring model tools in every harness.

### 5. Documentation and hardening

- Publish the capability matrix and intentional exceptions.
- Ensure CI fails for undeclared additions, missing declared surfaces, and stale documentation.

## Validation

Each phase runs the smallest relevant tests and typecheck before being committed. CI remains responsible for the complete suite and delivery reliability harness.

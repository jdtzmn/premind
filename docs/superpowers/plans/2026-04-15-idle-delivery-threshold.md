# Idle Delivery Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver pending PR reminders to sessions that have been continuously idle for at least `PREMIND_IDLE_DELIVERY_THRESHOLD_MS` (default 60 seconds), without waiting for the user to manually trigger another idle event.

**Architecture:** The plugin tracks per-session idle state (`idleSince`, `deliveryTimer`). When a session becomes idle, it starts a timer; when a pending batch exists and the threshold elapses, the reminder is injected. If the user becomes active before the timer fires, the timer is cancelled and the batch is preserved; delivery restarts on the next idle window. Multiple sessions on the same PR are evaluated independently.

**Tech Stack:** Node.js, TypeScript, `node:test`

---

## File Map

| File | What changes |
|---|---|
| `src/shared/constants.ts` | Add `PREMIND_IDLE_DELIVERY_THRESHOLD_MS = 60_000` |
| `src/plugin/index.ts` | Track `idleSince`/`deliveryTimer` per session; implement idle-threshold delivery; refactor injection into helper; update busy/idle handlers |
| `src/plugin/__tests__/compatibility.test.ts` | Update existing idle test to assert threshold behaviour; add tests for: already-idle delivery, busy-cancels-timer, busy-then-re-idle |
| `src/plugin/__tests__/idle-delivery.test.ts` | New focused test file for idle threshold scheduling logic |

---

## Task 1: Add the threshold constant

**Files:**
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Add the constant**

Replace the contents of `src/shared/constants.ts` with:

```typescript
import os from "node:os"
import path from "node:path"

export const PREMIND_PROTOCOL_VERSION = 1
export const PREMIND_SOCKET_PATH = path.join(os.tmpdir(), "premind.sock")
export const PREMIND_STATE_DIR =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "premind")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "premind")
export const PREMIND_DB_PATH = path.join(PREMIND_STATE_DIR, "premind.db")
export const PREMIND_EVENT_DETAIL_DIR = path.join(PREMIND_STATE_DIR, "event-details")
export const PREMIND_CLIENT_HEARTBEAT_MS = 10_000
export const PREMIND_CLIENT_LEASE_TTL_MS = 30_000
export const PREMIND_IDLE_SHUTDOWN_GRACE_MS = 15_000
export const PREMIND_IDLE_DELIVERY_THRESHOLD_MS = 60_000
```

- [ ] **Step 2: Run type check**

Run: `bun run check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat: add PREMIND_IDLE_DELIVERY_THRESHOLD_MS constant"
```

---

## Task 2: Write failing tests for idle-threshold delivery

**Files:**
- Create: `src/plugin/__tests__/idle-delivery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/plugin/__tests__/idle-delivery.test.ts` with the following content:

```typescript
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"
import { PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "../../shared/constants.ts"

// Helpers ---------------------------------------------------------------

type FakeDaemonOpts = {
  pendingBatch?: { batchId: string; sessionId: string; reminderText: string; events: unknown[] } | null
}

const makeDaemon = (opts: FakeDaemonOpts = {}) => {
  const acknowledgements: Array<{ batchId: string; state: string }> = []
  let pendingBatch = opts.pendingBatch !== undefined
    ? opts.pendingBatch
    : { batchId: "batch-1", sessionId: "session-1", reminderText: "<system-reminder>update</system-reminder>", events: [] }

  const daemon = {
    registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
    heartbeat: async () => undefined,
    release: async () => undefined,
    registerSession: async () => undefined,
    updateSessionState: async () => undefined,
    unregisterSession: async () => undefined,
    pauseSession: async () => undefined,
    resumeSession: async () => undefined,
    getPendingReminder: async (_sessionId: string) => ({ batch: pendingBatch }),
    ackReminder: async ({ batchId, state }: { batchId: string; state: string }) => {
      acknowledgements.push({ batchId, state })
      if (state === "confirmed" || state === "handed_off") pendingBatch = null
    },
    debugStatus: async () => ({ daemon: {}, activeClients: 0, activeSessions: 0, activeWatchers: 0, sessions: [] }),
    _acknowledgements: acknowledgements,
    _setPendingBatch: (b: typeof pendingBatch) => { pendingBatch = b },
  }
  return daemon
}

const makePlugin = async (daemon: ReturnType<typeof makeDaemon>) => {
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
  })({
    directory: "/tmp/project",
    worktree: "/tmp/project",
    client: {
      session: {
        get: async () => ({ data: {} }),
        prompt: async () => {},
        promptAsync: async ({ path, body }: any) => {
          asyncPrompts.push({ sessionId: path.id, text: body.parts[0].text })
        },
      },
    },
  } as never)

  const runtime = plugin as unknown as {
    config: (input: Record<string, unknown>) => Promise<void>
    event: (input: { event: unknown }) => Promise<void>
    "chat.message": (input: unknown, output: unknown) => Promise<void>
  }

  await runtime.config({})
  return { runtime, asyncPrompts }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const fireSessionCreated = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.created", properties: { sessionID: sessionId } } })

const fireSessionIdle = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

const fireSessionBusy = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } })

// Tests -----------------------------------------------------------------

describe("idle delivery threshold", () => {
  test("session idle longer than threshold: delivers immediately when batch arrives", async () => {
    const daemon = makeDaemon({ pendingBatch: null })
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireSessionCreated(runtime, "session-1")
    await fireSessionIdle(runtime, "session-1")

    // Simulate session already idle for longer than threshold
    await sleep(PREMIND_IDLE_DELIVERY_THRESHOLD_MS + 50)

    // New batch arrives
    daemon._setPendingBatch({
      batchId: "batch-late",
      sessionId: "session-1",
      reminderText: "<system-reminder>late comment</system-reminder>",
      events: [],
    })

    // Fire another idle event (simulating daemon detecting new batch triggers re-check)
    await fireSessionIdle(runtime, "session-1")

    assert.equal(asyncPrompts.length, 1, "should have delivered reminder immediately")
    assert.match(asyncPrompts[0].text, /late comment/)
  })

  test("session idle less than threshold: delivers after threshold elapses", async () => {
    const threshold = PREMIND_IDLE_DELIVERY_THRESHOLD_MS
    const daemon = makeDaemon()
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireSessionCreated(runtime, "session-1")
    await fireSessionIdle(runtime, "session-1")

    // Should not deliver immediately (not idle long enough)
    assert.equal(asyncPrompts.length, 0, "should not deliver before threshold")

    // Wait for timer to fire
    await sleep(threshold + 200)

    assert.equal(asyncPrompts.length, 1, "should deliver after threshold elapses")
  })

  test("user becomes busy before timer fires: cancels delivery, retries on next idle", async () => {
    const daemon = makeDaemon()
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireSessionCreated(runtime, "session-1")
    await fireSessionIdle(runtime, "session-1")

    // User becomes busy before threshold
    await sleep(50)
    await fireSessionBusy(runtime, "session-1")

    // Wait past what would have been the threshold
    await sleep(PREMIND_IDLE_DELIVERY_THRESHOLD_MS + 200)

    assert.equal(asyncPrompts.length, 0, "timer should have been cancelled on busy")

    // User goes idle again — new idle window starts
    await fireSessionIdle(runtime, "session-1")
    await sleep(PREMIND_IDLE_DELIVERY_THRESHOLD_MS + 200)

    assert.equal(asyncPrompts.length, 1, "should deliver after second idle window")
  })

  test("two sessions on same PR deliver independently", async () => {
    const daemon = makeDaemon()
    const asyncPrompts: Array<{ sessionId: string; text: string }> = []
    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
    })({
      directory: "/tmp/project",
      worktree: "/tmp/project",
      client: {
        session: {
          get: async () => ({ data: {} }),
          prompt: async () => {},
          promptAsync: async ({ path, body }: any) => {
            asyncPrompts.push({ sessionId: path.id, text: body.parts[0].text })
          },
        },
      },
    } as never)

    const runtime = plugin as unknown as {
      config: (input: Record<string, unknown>) => Promise<void>
      event: (input: { event: unknown }) => Promise<void>
    }
    await runtime.config({})

    // Session A goes idle
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-a" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } })

    // Session B becomes busy immediately
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-b" } } })
    await runtime.event({ event: { type: "session.status", properties: { sessionID: "session-b", status: { type: "busy" } } } })

    // Wait for session-a's threshold
    await sleep(PREMIND_IDLE_DELIVERY_THRESHOLD_MS + 200)

    const aDeliveries = asyncPrompts.filter((p) => p.sessionId === "session-a")
    const bDeliveries = asyncPrompts.filter((p) => p.sessionId === "session-b")
    assert.equal(aDeliveries.length, 1, "session-a should have received reminder")
    assert.equal(bDeliveries.length, 0, "session-b should not have received reminder while busy")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/plugin/__tests__/idle-delivery.test.ts`
Expected: tests fail (functionality not yet implemented)

---

## Task 3: Implement idle-threshold delivery in the plugin

**Files:**
- Modify: `src/plugin/index.ts`

The plugin needs to:
1. Import `PREMIND_IDLE_DELIVERY_THRESHOLD_MS`
2. Track per-session `idleSince` and `deliveryTimer` state
3. Refactor `handleSessionIdle` to use a shared `deliverPendingReminder` helper
4. On idle: record `idleSince`, schedule delivery after the threshold
5. On busy: clear `idleSince` and cancel the timer (keep batch)
6. When scheduling: if already past threshold, deliver immediately

- [ ] **Step 1: Update `src/plugin/index.ts`**

Change the import line at the top from:
```typescript
import { PREMIND_CLIENT_HEARTBEAT_MS } from "../shared/constants.ts"
```
to:
```typescript
import { PREMIND_CLIENT_HEARTBEAT_MS, PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "../shared/constants.ts"
```

- [ ] **Step 2: Add per-session idle state tracking maps**

After the line:
```typescript
  const inflightReminders = new Map<string, string>()
  let lastPrimarySessionId: string | undefined
```

Add:
```typescript
  // Per-session idle state for threshold-based delivery.
  const idleSince = new Map<string, number>()
  const deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

- [ ] **Step 3: Extract a `deliverPendingReminder` helper**

Replace the body of `handleSessionIdle` so it delegates to a new shared helper.

Replace the existing `handleSessionIdle` function:

```typescript
  const handleSessionIdle = async (sessionID: string) => {
    const git = await gitDetector(root)
    try {
      await daemon.updateSessionState({ sessionId: sessionID, busyState: "idle", repo: git.repo, branch: git.branch })
    } catch (error) {
      // Session may not be registered (e.g. child session, or created event missed). Skip silently.
      if (isSessionNotFound(error)) return
      throw error
    }
    const pending = await daemon.getPendingReminder(sessionID)
    if (!pending.batch) return

    await daemon.ackReminder({
      batchId: pending.batch.batchId,
      sessionId: sessionID,
      state: "handed_off",
    })

    inflightReminders.set(sessionID, pending.batch.batchId)
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: `${pending.batch.reminderText}\n\n${REMINDER_MARKER_PREFIX}${pending.batch.batchId}` }],
        },
      })
    } catch (error) {
      inflightReminders.delete(sessionID)
      await daemon.ackReminder({
        batchId: pending.batch.batchId,
        sessionId: sessionID,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
```

With:

```typescript
  // Attempt immediate delivery of a pending reminder for a session.
  // Does nothing if no batch exists or if one is already in-flight.
  const deliverPendingReminder = async (sessionID: string) => {
    if (inflightReminders.has(sessionID)) return
    const pending = await daemon.getPendingReminder(sessionID)
    if (!pending.batch) return

    await daemon.ackReminder({
      batchId: pending.batch.batchId,
      sessionId: sessionID,
      state: "handed_off",
    })

    inflightReminders.set(sessionID, pending.batch.batchId)
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: `${pending.batch.reminderText}\n\n${REMINDER_MARKER_PREFIX}${pending.batch.batchId}` }],
        },
      })
    } catch (error) {
      inflightReminders.delete(sessionID)
      await daemon.ackReminder({
        batchId: pending.batch.batchId,
        sessionId: sessionID,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Schedule delivery for a session that just became idle.
  // If already past the threshold, deliver immediately.
  // Otherwise set a timer that fires once the threshold elapses.
  const scheduleDelivery = (sessionID: string) => {
    // Cancel any existing timer for this session.
    const existing = deliveryTimers.get(sessionID)
    if (existing !== undefined) {
      clearTimeout(existing)
      deliveryTimers.delete(sessionID)
    }

    const since = idleSince.get(sessionID)
    if (since === undefined) return

    const elapsed = Date.now() - since
    const remaining = PREMIND_IDLE_DELIVERY_THRESHOLD_MS - elapsed

    if (remaining <= 0) {
      // Already idle long enough — deliver now.
      void deliverPendingReminder(sessionID)
      return
    }

    // Schedule delivery for when the threshold is reached.
    const timer = setTimeout(() => {
      deliveryTimers.delete(sessionID)
      void deliverPendingReminder(sessionID)
    }, remaining)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    deliveryTimers.set(sessionID, timer)
  }

  const handleSessionIdle = async (sessionID: string) => {
    const git = await gitDetector(root)
    try {
      await daemon.updateSessionState({ sessionId: sessionID, busyState: "idle", repo: git.repo, branch: git.branch })
    } catch (error) {
      // Session may not be registered (e.g. child session, or created event missed). Skip silently.
      if (isSessionNotFound(error)) return
      throw error
    }

    // Record idle start time if not already idle, then schedule threshold-based delivery.
    if (!idleSince.has(sessionID)) {
      idleSince.set(sessionID, Date.now())
    }
    scheduleDelivery(sessionID)
  }
```

- [ ] **Step 4: Update the busy handler to cancel timers and reset idle state**

Find the busy handling in the event handler:
```typescript
        if (statusType === "busy" || statusType === "retry") {
          await daemon.updateSessionState({ sessionId: sessionID, busyState: "busy" }).catch((error) => {
            if (!isSessionNotFound(error)) throw error
          })
        }
```

Replace with:
```typescript
        if (statusType === "busy" || statusType === "retry") {
          await daemon.updateSessionState({ sessionId: sessionID, busyState: "busy" }).catch((error) => {
            if (!isSessionNotFound(error)) throw error
          })
          // Cancel any pending idle-delivery timer and reset the idle clock.
          const timer = deliveryTimers.get(sessionID)
          if (timer !== undefined) {
            clearTimeout(timer)
            deliveryTimers.delete(sessionID)
          }
          idleSince.delete(sessionID)
        }
```

- [ ] **Step 5: Update the chat.message busy handler similarly**

Find:
```typescript
      await daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" }).catch((error) => {
        if (!isSessionNotFound(error)) throw error
      })
    },
```

Replace with:
```typescript
      await daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" }).catch((error) => {
        if (!isSessionNotFound(error)) throw error
      })
      // Cancel any pending idle-delivery timer and reset the idle clock.
      const timer = deliveryTimers.get(input.sessionID)
      if (timer !== undefined) {
        clearTimeout(timer)
        deliveryTimers.delete(input.sessionID)
      }
      idleSince.delete(input.sessionID)
    },
```

- [ ] **Step 6: Clean up timers on session deletion**

Find:
```typescript
      if (event.type === "session.deleted") {
        await daemon.unregisterSession(sessionID)
      }
```

Replace with:
```typescript
      if (event.type === "session.deleted") {
        await daemon.unregisterSession(sessionID)
        const timer = deliveryTimers.get(sessionID)
        if (timer !== undefined) {
          clearTimeout(timer)
          deliveryTimers.delete(sessionID)
        }
        idleSince.delete(sessionID)
      }
```

- [ ] **Step 7: Run the failing tests to verify they now pass**

Run: `node --import tsx --test src/plugin/__tests__/idle-delivery.test.ts`
Expected: all 4 tests pass

Note: the tests use real timers and `PREMIND_IDLE_DELIVERY_THRESHOLD_MS = 60_000`. That would make them very slow. Before running, temporarily reduce the constant to a small value like `200` for the test run, then restore it. Alternatively, proceed directly to Task 4 which adds a test-injectable threshold.

---

## Task 4: Make the threshold injectable in tests

The 60-second constant makes real-timer tests impractical. Add an optional `idleDeliveryThresholdMs` to `PremindPluginDependencies` so tests can inject a short value.

**Files:**
- Modify: `src/plugin/index.ts`
- Modify: `src/plugin/__tests__/idle-delivery.test.ts`

- [ ] **Step 1: Add `idleDeliveryThresholdMs` to `PremindPluginDependencies`**

Find:
```typescript
export type PremindPluginDependencies = {
  createDaemonClient?: () => DaemonClientLike
  detectGit?: (cwd: string) => Promise<{ repo: string; branch: string }>
  ensureDaemon?: () => Promise<void>
}
```

Replace with:
```typescript
export type PremindPluginDependencies = {
  createDaemonClient?: () => DaemonClientLike
  detectGit?: (cwd: string) => Promise<{ repo: string; branch: string }>
  ensureDaemon?: () => Promise<void>
  idleDeliveryThresholdMs?: number
}
```

- [ ] **Step 2: Use the injectable threshold inside `createPremindPlugin`**

Find the line:
```typescript
  const startDaemon = dependencies.ensureDaemon ?? ensureDaemonRunning
```

Add immediately after:
```typescript
  const idleDeliveryThreshold = dependencies.idleDeliveryThresholdMs ?? PREMIND_IDLE_DELIVERY_THRESHOLD_MS
```

- [ ] **Step 3: Use `idleDeliveryThreshold` inside `scheduleDelivery`**

Find both occurrences of `PREMIND_IDLE_DELIVERY_THRESHOLD_MS` inside `scheduleDelivery` and replace with `idleDeliveryThreshold`:

```typescript
    const remaining = idleDeliveryThreshold - elapsed
```

- [ ] **Step 4: Update `src/plugin/__tests__/idle-delivery.test.ts` to inject a short threshold**

Change the `makeDaemon` helper signature and `makePlugin` helper to accept and forward a threshold:

Replace:
```typescript
const makePlugin = async (daemon: ReturnType<typeof makeDaemon>) => {
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
  })({
```

With:
```typescript
const TEST_THRESHOLD_MS = 200

const makePlugin = async (daemon: ReturnType<typeof makeDaemon>, thresholdMs = TEST_THRESHOLD_MS) => {
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: thresholdMs,
  })({
```

- [ ] **Step 5: Update all `sleep` calls in the tests to use `TEST_THRESHOLD_MS`**

Replace every `PREMIND_IDLE_DELIVERY_THRESHOLD_MS` reference in the test sleep calls:

```typescript
// In "delivers immediately when batch arrives":
await sleep(TEST_THRESHOLD_MS + 50)
// ...
await sleep(TEST_THRESHOLD_MS + 200)  // (not present in this test, but timer-based ones use it)

// In "delivers after threshold elapses":
const threshold = TEST_THRESHOLD_MS
// ...
await sleep(threshold + 200)

// In "busy cancels timer, retries on re-idle":
await sleep(50)
// ...
await sleep(TEST_THRESHOLD_MS + 200)
// ...
await sleep(TEST_THRESHOLD_MS + 200)

// In "two sessions deliver independently":
await sleep(TEST_THRESHOLD_MS + 200)
```

Also update the `makePlugin` call in the two-session test to use `TEST_THRESHOLD_MS`:
```typescript
    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: TEST_THRESHOLD_MS,
    })({
```

Also remove the `import { PREMIND_IDLE_DELIVERY_THRESHOLD_MS }` import from the test file since it's no longer used.

- [ ] **Step 6: Run the idle-delivery tests**

Run: `node --import tsx --test src/plugin/__tests__/idle-delivery.test.ts`
Expected: all 4 tests pass

- [ ] **Step 7: Run the full suite**

Run: `bun run check && bun run test`
Expected: type check clean, all tests pass

- [ ] **Step 8: Commit**

```bash
git add src/shared/constants.ts src/plugin/index.ts src/plugin/__tests__/idle-delivery.test.ts
git commit -m "feat: deliver pending reminders after idle threshold elapses"
```

---

## Task 5: Update compatibility test to reflect new idle behaviour

The existing compatibility test fires `session.idle` and expects immediate delivery. That is now only true if the session has been idle past the threshold. Update the test to inject a zero threshold so it keeps fast while staying accurate.

**Files:**
- Modify: `src/plugin/__tests__/compatibility.test.ts`

- [ ] **Step 1: Pass `idleDeliveryThresholdMs: 0` into the existing test plugin creation**

Find:
```typescript
    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
    })({
```

Replace with:
```typescript
    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: 0,
    })({
```

- [ ] **Step 2: Run the full suite**

Run: `bun run check && bun run test`
Expected: type check clean, all 32+ tests pass (28 existing + 4 new idle-delivery)

- [ ] **Step 3: Commit**

```bash
git add src/plugin/__tests__/compatibility.test.ts
git commit -m "test: use zero idle threshold in compatibility harness for instant delivery"
```

---

## Task 6: Push and verify end-to-end

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Clear cache and verify live run**

```bash
rm -rf ~/.cache/opencode/packages/premind@git+https:/github.com/jdtzmn/premind.git
opencode run --print-logs "hello" 2>&1 | grep -i "premind\|error\|ERROR"
```

Expected: no errors, plugin loads, all four tools register.

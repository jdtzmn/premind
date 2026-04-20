import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_THRESHOLD_MS = 200

import type { ReminderBatch } from "../../shared/schema.ts"

type PendingBatch = ReminderBatch | null

const makeDaemon = (initialBatch: PendingBatch = {
  batchId: "batch-1",
  sessionId: "session-1",
  reminderText: "<system-reminder>update</system-reminder>",
  events: [],
}) => {
  const acknowledgements: Array<{ batchId: string; state: string }> = []
  let pendingBatch = initialBatch

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
      if (state === "handed_off" || state === "confirmed") pendingBatch = null
    },
    debugStatus: async () => ({ daemon: {}, activeClients: 0, activeSessions: 0, activeWatchers: 0, lastReapAt: null, lastReapCount: 0, sessions: [] }),
    // Test helpers
    _acknowledgements: acknowledgements,
    _setPendingBatch: (b: PendingBatch) => { pendingBatch = b },
  }
  return daemon
}

const makePlugin = async (daemon: ReturnType<typeof makeDaemon>, thresholdMs = TEST_THRESHOLD_MS) => {
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon as never,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: thresholdMs,
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
      tui: {
        showToast: async () => undefined,
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

const fireCreated = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.created", properties: { sessionID: sessionId } } })

const fireIdle = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

const fireBusy = (runtime: Awaited<ReturnType<typeof makePlugin>>["runtime"], sessionId: string) =>
  runtime.event({ event: { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idle delivery threshold", () => {
  test("session already past threshold when batch arrives: delivers immediately on next idle", async () => {
    // Start with no pending batch.
    const daemon = makeDaemon(null)
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireCreated(runtime, "session-1")
    await fireIdle(runtime, "session-1")

    // Wait longer than the threshold so the session is "well past" idle.
    await sleep(TEST_THRESHOLD_MS + 50)

    // New batch arrives.
    daemon._setPendingBatch({
      batchId: "batch-late",
      sessionId: "session-1",
      reminderText: "<system-reminder>late comment</system-reminder>",
      events: [],
    })

    // Another idle event fires (e.g. session.status idle or session.idle from OpenCode).
    await fireIdle(runtime, "session-1")

    assert.equal(asyncPrompts.length, 1, "should have delivered reminder immediately")
    assert.match(asyncPrompts[0].text, /late comment/)
  })

  test("session just became idle: delivers after threshold elapses without another event", async () => {
    const daemon = makeDaemon()
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireCreated(runtime, "session-1")
    await fireIdle(runtime, "session-1")

    // Should not deliver before the threshold.
    assert.equal(asyncPrompts.length, 0, "should not deliver immediately")

    // Wait for timer to fire.
    await sleep(TEST_THRESHOLD_MS + 100)

    assert.equal(asyncPrompts.length, 1, "should deliver after threshold elapses")
  })

  test("user becomes busy before timer fires: cancels delivery, retries on re-idle", async () => {
    const daemon = makeDaemon()
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireCreated(runtime, "session-1")
    await fireIdle(runtime, "session-1")

    // User becomes busy well before the threshold.
    await sleep(20)
    await fireBusy(runtime, "session-1")

    // Wait past what would have been the timer.
    await sleep(TEST_THRESHOLD_MS + 100)

    assert.equal(asyncPrompts.length, 0, "timer should have been cancelled on busy")

    // User goes idle again — new idle window starts.
    await fireIdle(runtime, "session-1")
    await sleep(TEST_THRESHOLD_MS + 100)

    assert.equal(asyncPrompts.length, 1, "should deliver after second idle window completes")
  })

  test("two sessions on same PR deliver independently", async () => {
    const daemon = makeDaemon()
    const asyncPrompts: Array<{ sessionId: string; text: string }> = []

    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon as never,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: TEST_THRESHOLD_MS,
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
        tui: {
          showToast: async () => undefined,
        },
      },
    } as never)

    const runtime = plugin as unknown as {
      config: (input: Record<string, unknown>) => Promise<void>
      event: (input: { event: unknown }) => Promise<void>
    }
    await runtime.config({})

    // Session A goes idle.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-a" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } })

    // Session B created but stays busy.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-b" } } })
    await runtime.event({ event: { type: "session.status", properties: { sessionID: "session-b", status: { type: "busy" } } } })

    // Wait for session-a's threshold.
    await sleep(TEST_THRESHOLD_MS + 100)

    const aDeliveries = asyncPrompts.filter((p) => p.sessionId === "session-a")
    const bDeliveries = asyncPrompts.filter((p) => p.sessionId === "session-b")
    assert.equal(aDeliveries.length, 1, "session-a should have received reminder")
    assert.equal(bDeliveries.length, 0, "session-b should not have received reminder while busy")
  })

  test("no delivery when no pending batch", async () => {
    const daemon = makeDaemon(null)
    const { runtime, asyncPrompts } = await makePlugin(daemon)

    await fireCreated(runtime, "session-1")
    await fireIdle(runtime, "session-1")
    await sleep(TEST_THRESHOLD_MS + 100)

    assert.equal(asyncPrompts.length, 0, "no reminder when no pending batch")
  })

  test("bootstrap: daemon reports an idle session with a pending batch — delivery is scheduled without waiting for idle poll", async () => {
    // Simulate the opencode-restart scenario: plugin starts fresh, daemon still has
    // the session registered as idle, and a batch is waiting.
    const daemon = makeDaemon({
      batchId: "batch-bootstrap",
      sessionId: "pre-existing-session",
      reminderText: "<system-reminder>pending at startup</system-reminder>",
      events: [{} as never], // non-empty so the toast reflects a real count
    })
    // Inject the session into debugStatus so bootstrap notices it.
    daemon.debugStatus = async () => ({
      daemon: {},
      activeClients: 1,
      activeSessions: 1,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [
        { sessionId: "pre-existing-session", repo: "acme/repo", branch: "feature/test", busyState: "idle" },
      ],
    })

    const { asyncPrompts } = await makePlugin(daemon)

    // Let the bootstrap microtask + the zero-threshold scheduleDelivery run.
    // idleDeliveryThresholdMs defaults to TEST_THRESHOLD_MS (200), so wait just past it.
    await sleep(TEST_THRESHOLD_MS + 100)

    assert.equal(asyncPrompts.length, 1, "bootstrap should have delivered the pending batch after threshold")
    assert.match(asyncPrompts[0].text, /pending at startup/)
  })
})

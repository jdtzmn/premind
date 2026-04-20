import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"
import type { ReminderBatch } from "../../shared/schema.ts"

// ---------------------------------------------------------------------------
// Reproduces the stuck-inflight scenario: a previous hand-off set
// inflightReminders but the chat.message confirmation never arrived (e.g.
// because opencode reattached mid-delivery). Before the TTL gate, the session
// could not receive further deliveries. With the gate, once the stale entry
// ages past inflightStaleTtlMs the next delivery attempt clears it and
// proceeds with a fresh hand-off.
// ---------------------------------------------------------------------------

const makePlugin = async (options: {
  initialBatch: ReminderBatch | null
  inflightStaleTtlMs: number
  idleDeliveryThresholdMs: number
}) => {
  let pending: ReminderBatch | null = options.initialBatch
  const acks: Array<{ batchId: string; state: string }> = []
  const daemon = {
    registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
    heartbeat: async () => undefined,
    release: async () => undefined,
    registerSession: async () => undefined,
    updateSessionState: async () => undefined,
    unregisterSession: async () => undefined,
    pauseSession: async () => undefined,
    resumeSession: async () => undefined,
    getPendingReminder: async () => ({ batch: pending }),
    ackReminder: async ({ batchId, state }: { batchId: string; state: string }) => {
      acks.push({ batchId, state })
      if (state === "handed_off" || state === "confirmed") pending = null
    },
    debugStatus: async () => ({ daemon: {}, activeClients: 0, activeSessions: 0, activeWatchers: 0, lastReapAt: null, lastReapCount: 0, sessions: [] }),
  }

  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon as never,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: options.idleDeliveryThresholdMs,
    inflightStaleTtlMs: options.inflightStaleTtlMs,
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

  return {
    runtime,
    asyncPrompts,
    acks,
    setPending: (b: ReminderBatch | null) => { pending = b },
  }
}

describe("stale inflight reminder TTL", () => {
  test("fresh inflight gates a second delivery for the same session", async () => {
    const { runtime, asyncPrompts, setPending } = await makePlugin({
      initialBatch: {
        batchId: "batch-1",
        sessionId: "session-1",
        reminderText: "<system-reminder>first</system-reminder>",
        events: [],
      },
      idleDeliveryThresholdMs: 10,
      // TTL long enough that the second attempt below falls inside it.
      inflightStaleTtlMs: 5_000,
    })

    // First delivery fires.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(asyncPrompts.length, 1, "first delivery should have fired")

    // Queue another batch — ack for batch-1 never comes.
    setPending({
      batchId: "batch-2",
      sessionId: "session-1",
      reminderText: "<system-reminder>second</system-reminder>",
      events: [],
    })

    // Fire another idle event; inflight is still fresh, so delivery must be gated.
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(asyncPrompts.length, 1, "second delivery must be gated while inflight is fresh")
  })

  test("stale inflight is cleared, allowing a fresh delivery for the same session", async () => {
    const { runtime, asyncPrompts, setPending } = await makePlugin({
      initialBatch: {
        batchId: "batch-1",
        sessionId: "session-1",
        reminderText: "<system-reminder>first</system-reminder>",
        events: [],
      },
      idleDeliveryThresholdMs: 10,
      // Very short TTL so we can observe the staleness clear within the test.
      inflightStaleTtlMs: 100,
    })

    // First delivery fires.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(asyncPrompts.length, 1, "first delivery should have fired")

    // Queue a new batch while the first hand-off is still "inflight" (no ack).
    setPending({
      batchId: "batch-2",
      sessionId: "session-1",
      reminderText: "<system-reminder>second</system-reminder>",
      events: [],
    })

    // Wait longer than the TTL so the inflight entry becomes stale.
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Trigger another delivery attempt.
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(asyncPrompts.length, 2, "stale inflight entry should have been cleared, allowing a new delivery")
    assert.match(asyncPrompts[1].text, /second/)
  })
})

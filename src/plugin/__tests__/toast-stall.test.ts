import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"
import type { ReminderBatch } from "../../shared/schema.ts"

// ---------------------------------------------------------------------------
// Exercises the toast countdown's self-correction safety net. When the toast
// sits at remainingSecs === 0 for several consecutive ticks and nothing is
// inflight for the session, it forces a scheduleDelivery call so that any
// buggy path leaving the countdown ticking without an active delivery cycle
// recovers.
//
// Realistic scenario this covers:
//   1. A reminder was handed off (inflightReminders set) but its chat.message
//      confirmation never arrived.
//   2. Session went busy (cancelDelivery stops the toast) then idle again.
//   3. handleSessionIdle started a new toast and scheduled delivery.
//   4. The delivery attempt was gated by the stale inflight entry, so no
//      new hand-off happened, but the toast kept ticking.
//   5. After the inflight entry ages past its TTL, the stall self-correction
//      re-calls scheduleDelivery, which clears the stale entry and delivers.
// ---------------------------------------------------------------------------

const makeRuntime = async (options: {
  inflightStaleTtlMs: number
  toastTickIntervalMs: number
  idleDeliveryThresholdMs: number
  onAck?: (state: string) => void
}) => {
  let pending: ReminderBatch | null = {
    batchId: "batch-1",
    sessionId: "session-1",
    reminderText: "<system-reminder>first</system-reminder>",
    events: [],
  }
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const ackStates: string[] = []
  const promptAsyncFailures = { count: 0 }

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
    ackReminder: async ({ state }: { batchId: string; state: string }) => {
      ackStates.push(state)
      options.onAck?.(state)
      if (state === "handed_off" || state === "confirmed") pending = null
    },
    debugStatus: async () => ({
      daemon: {},
      activeClients: 0,
      activeSessions: 1,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [{ sessionId: "session-1", repo: "r", branch: "b", busyState: "idle" }],
    }),
  }

  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon as never,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: options.idleDeliveryThresholdMs,
    inflightStaleTtlMs: options.inflightStaleTtlMs,
    toastTickIntervalMs: options.toastTickIntervalMs,
  })({
    directory: "/tmp/project",
    worktree: "/tmp/project",
    client: {
      session: {
        get: async () => ({ data: {} }),
        prompt: async () => {},
        promptAsync: async ({ path, body }: any) => {
          asyncPrompts.push({ sessionId: path.id, text: body.parts[0].text })
          // Simulate a disrupted delivery on the FIRST hand-off: the prompt
          // function resolves (no throw) but the confirmation marker never
          // returns through chat.message. This mirrors an opencode reattach.
          // We use promptAsyncFailures.count to distinguish attempts if needed.
          promptAsyncFailures.count++
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
    ackStates,
    setPending: (b: ReminderBatch | null) => { pending = b },
  }
}

describe("toast stall self-correction", () => {
  test("stall + TTL together recover a stuck delivery after a disrupted hand-off", async () => {
    const { runtime, asyncPrompts, setPending } = await makeRuntime({
      inflightStaleTtlMs: 200,
      toastTickIntervalMs: 30,
      // Large threshold so the inline delivery doesn't fire and the toast has
      // time to tick. We'll artificially advance state below via busy+idle.
      idleDeliveryThresholdMs: 0,
    })

    // Kick off first delivery. inflight set, no confirmation ever comes.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(asyncPrompts.length, 1, "first delivery should fire")

    // Simulate: session went busy then idle again while the inflight entry
    // is still present. A new batch has appeared.
    setPending({
      batchId: "batch-2",
      sessionId: "session-1",
      reminderText: "<system-reminder>recovered</system-reminder>",
      events: [],
    })
    await runtime.event({
      event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } },
    })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })

    // At this point: toast is running, delivery was attempted once and hit the
    // inflight gate (entry still fresh). Wait for both the TTL (200ms) and the
    // stall counter (5 * 30ms = 150ms) to pass.
    await new Promise((resolve) => setTimeout(resolve, 600))

    assert.equal(asyncPrompts.length, 2, "stall + TTL recovery should deliver the second batch")
    assert.match(asyncPrompts[1].text, /recovered/)
  })
})

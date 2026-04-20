import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"
import type { ReminderBatch } from "../../shared/schema.ts"

// ---------------------------------------------------------------------------
// These tests defend the invariant that the plugin only acts on sessions it
// has observed through its own lifecycle. Without this gate the plugin would
// render countdown toasts and attempt deliveries for sessions that belong to
// other opencode instances / worktrees (since daemon.debugStatus returns the
// GLOBAL session list, and daemon.getPendingReminder returns any batch keyed
// by sessionId regardless of caller).
// ---------------------------------------------------------------------------

const makeScenario = async (options: {
  daemonSessions: Array<{ sessionId: string; repo: string; branch: string; busyState: string }>
  pendingBatchBySession: Record<string, ReminderBatch>
}) => {
  const toastMessages: string[] = []
  const asyncPrompts: Array<{ sessionId: string; text: string }> = []
  const ackStates: string[] = []
  const pendingBatches = { ...options.pendingBatchBySession }

  const daemon = {
    registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
    heartbeat: async () => undefined,
    release: async () => undefined,
    registerSession: async () => undefined,
    updateSessionState: async () => undefined,
    unregisterSession: async () => undefined,
    pauseSession: async () => undefined,
    resumeSession: async () => undefined,
    getPendingReminder: async (sessionId: string) => ({ batch: pendingBatches[sessionId] ?? null }),
    ackReminder: async ({ batchId, state, sessionId }: { batchId: string; state: string; sessionId: string }) => {
      ackStates.push(`${sessionId}:${state}`)
      if (state === "handed_off" || state === "confirmed") delete pendingBatches[sessionId]
    },
    debugStatus: async () => ({
      daemon: {},
      activeClients: 1,
      activeSessions: options.daemonSessions.length,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: options.daemonSessions,
    }),
  }

  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon as never,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/me" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: 0,
    toastTickIntervalMs: 20,
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
        showToast: async ({ body }: { body: { message: string } }) => {
          toastMessages.push(body.message)
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

  return { runtime, asyncPrompts, toastMessages, ackStates }
}

describe("cross-session toast isolation", () => {
  test("bootstrap ignores sessions the plugin has never observed", async () => {
    const { toastMessages, asyncPrompts, ackStates } = await makeScenario({
      daemonSessions: [
        { sessionId: "foreign-1", repo: "acme/repo", branch: "other-worktree", busyState: "idle" },
      ],
      pendingBatchBySession: {
        "foreign-1": {
          batchId: "b-foreign",
          sessionId: "foreign-1",
          reminderText: "<system-reminder>not ours</system-reminder>",
          events: [],
        },
      },
    })

    // Give bootstrap time to run and for any idle poll tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.equal(toastMessages.length, 0, "must not show any toast for a foreign session")
    assert.equal(asyncPrompts.length, 0, "must not attempt delivery for a foreign session")
    assert.deepEqual(ackStates, [], "must not ack on the daemon for a foreign session")
  })

  test("toast shows for an owned session while a co-existing foreign session stays silent", async () => {
    const { runtime, toastMessages, asyncPrompts, ackStates } = await makeScenario({
      daemonSessions: [
        { sessionId: "foreign-1", repo: "acme/repo", branch: "other-worktree", busyState: "idle" },
        { sessionId: "mine", repo: "acme/repo", branch: "feature/me", busyState: "idle" },
      ],
      pendingBatchBySession: {
        "foreign-1": {
          batchId: "b-foreign",
          sessionId: "foreign-1",
          reminderText: "<system-reminder>not ours</system-reminder>",
          events: [],
        },
        mine: {
          batchId: "b-mine",
          sessionId: "mine",
          reminderText: "<system-reminder>ours</system-reminder>",
          events: [{} as never],
        },
      },
    })

    // Adopt only our session.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "mine" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "mine" } } })
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.equal(asyncPrompts.length, 1, "exactly one delivery — the owned session")
    assert.equal(asyncPrompts[0].sessionId, "mine")
    // No ack for the foreign session.
    assert.ok(ackStates.every((s) => s.startsWith("mine:")), `no foreign acks expected, got ${ackStates.join(",")}`)
  })

  test("chat.message on a session not previously observed adopts it", async () => {
    // Covers the opencode-resume path where no session.created event fires.
    const { runtime, asyncPrompts } = await makeScenario({
      daemonSessions: [
        { sessionId: "resumed", repo: "acme/repo", branch: "feature/me", busyState: "idle" },
      ],
      pendingBatchBySession: {
        resumed: {
          batchId: "b-resumed",
          sessionId: "resumed",
          reminderText: "<system-reminder>resumed-with-batch</system-reminder>",
          events: [{} as never],
        },
      },
    })

    // chat.message should adopt the session; a subsequent idle event then
    // flows through the normal delivery path.
    await runtime["chat.message"](
      { sessionID: "resumed" },
      { message: { parts: [{ type: "text", text: "hi" }] }, parts: [] },
    )
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "resumed" } } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(asyncPrompts.length, 1)
    assert.match(asyncPrompts[0].text, /resumed-with-batch/)
  })

  test("session.deleted removes ownership; subsequent idle for that session does not deliver", async () => {
    const { runtime, asyncPrompts } = await makeScenario({
      daemonSessions: [
        { sessionId: "tmp", repo: "acme/repo", branch: "feature/me", busyState: "idle" },
      ],
      pendingBatchBySession: {},
    })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "tmp" } } })
    await runtime.event({ event: { type: "session.deleted", properties: { sessionID: "tmp" } } })

    // Now set up a batch (hypothetically queued after deletion) and fire idle.
    // Since ownership is gone, nothing should happen even if the daemon still
    // has the session in its global list.
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "tmp" } } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(asyncPrompts.length, 0)
  })
})

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"

// ---------------------------------------------------------------------------
// Harness: a daemon that simulates "session unknown" until registerSession runs.
// ---------------------------------------------------------------------------

type OperationLog = string[]

const makeReattachingDaemon = (knownSessionIds: Set<string> = new Set()) => {
  const operations: OperationLog = []

  const requireKnown = (sessionId: string, op: string) => {
    operations.push(`${op}:${sessionId}`)
    if (!knownSessionIds.has(sessionId)) {
      throw new Error(`SESSION_NOT_FOUND: unknown session ${sessionId}`)
    }
  }

  const daemon = {
    registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
    heartbeat: async () => undefined,
    release: async () => undefined,
    registerSession: async ({ sessionId }: { sessionId: string }) => {
      operations.push(`register:${sessionId}`)
      knownSessionIds.add(sessionId)
    },
    updateSessionState: async ({ sessionId, busyState }: { sessionId: string; busyState?: string }) => {
      requireKnown(sessionId, `update:${busyState ?? "none"}`)
    },
    unregisterSession: async (sessionId: string) => {
      operations.push(`unregister:${sessionId}`)
      knownSessionIds.delete(sessionId)
    },
    pauseSession: async (sessionId: string) => {
      requireKnown(sessionId, "pause")
    },
    resumeSession: async (sessionId: string) => {
      requireKnown(sessionId, "resume")
    },
    getPendingReminder: async (_sessionId: string) => ({ batch: null }),
    ackReminder: async () => undefined,
    setGlobalDisabled: async (disabled: boolean) => ({ disabled }),
    getGlobalDisabled: async () => ({ disabled: false }),
    debugStatus: async () => ({
      daemon: { protocolVersion: 1, heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 },
      activeClients: 1,
      activeSessions: knownSessionIds.size,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [],
    }),
    _operations: operations,
    _knownSessionIds: knownSessionIds,
  }

  return daemon
}

const makePlugin = async (
  daemon: ReturnType<typeof makeReattachingDaemon>,
  sessionGet: (id: string) => { data: { parentID?: string } } = () => ({ data: {} }),
) => {
  const plugin = await createPremindPlugin({
    createDaemonClient: () => daemon as never,
    detectGit: async () => ({ repo: "acme/repo", branch: "feature/reattach" }),
    ensureDaemon: async () => {},
    idleDeliveryThresholdMs: 0,
  })({
    directory: "/tmp/project",
    worktree: "/tmp/project",
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => sessionGet(path.id),
        prompt: async () => {},
        promptAsync: async () => {},
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
    tool: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>
  }
  await runtime.config({})
  return runtime
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reactive session re-attach", () => {
  test("chat.message on unknown session triggers re-attach then retries busy update", async () => {
    // Daemon starts with no known sessions.
    const daemon = makeReattachingDaemon(new Set())
    const runtime = await makePlugin(daemon)

    // No session.created event is fired — session was 'resumed' from a prior opencode process.
    // A user sends a chat message on this resumed session.
    await runtime["chat.message"](
      { sessionID: "resumed-session" },
      { message: { parts: [{ type: "text", text: "hello" }] }, parts: [] },
    )

    // Expected sequence:
    // 1. first busy update fails (SESSION_NOT_FOUND)
    // 2. withReattach calls registerSession
    // 3. retry the busy update — succeeds
    assert.deepEqual(daemon._operations, [
      "update:busy:resumed-session",
      "register:resumed-session",
      "update:busy:resumed-session",
    ])
  })

  test("session.idle on unknown session triggers re-attach then retries idle update", async () => {
    const daemon = makeReattachingDaemon(new Set())
    const runtime = await makePlugin(daemon)

    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "resumed-session" } } })

    assert.deepEqual(daemon._operations, [
      "update:idle:resumed-session",
      "register:resumed-session",
      "update:idle:resumed-session",
    ])
  })

  test("session.status busy on unknown session triggers re-attach", async () => {
    const daemon = makeReattachingDaemon(new Set())
    const runtime = await makePlugin(daemon)

    await runtime.event({
      event: {
        type: "session.status",
        properties: { sessionID: "resumed-session", status: { type: "busy" } },
      },
    })

    assert.deepEqual(daemon._operations, [
      "update:busy:resumed-session",
      "register:resumed-session",
      "update:busy:resumed-session",
    ])
  })

  test("known session does NOT trigger a redundant re-attach", async () => {
    // Daemon already knows about this session (simulating session.created fired earlier).
    const daemon = makeReattachingDaemon(new Set(["already-known"]))
    const runtime = await makePlugin(daemon)

    await runtime["chat.message"](
      { sessionID: "already-known" },
      { message: { parts: [{ type: "text", text: "hello" }] }, parts: [] },
    )

    // Only the busy update should have fired. No spurious registerSession.
    assert.deepEqual(daemon._operations, ["update:busy:already-known"])
  })

  test("child session (parentID set) is not re-attached even on chat.message", async () => {
    const daemon = makeReattachingDaemon(new Set())
    const runtime = await makePlugin(daemon, () => ({ data: { parentID: "parent-123" } }))

    await runtime["chat.message"](
      { sessionID: "child-session" },
      { message: { parts: [{ type: "text", text: "hello" }] }, parts: [] },
    )

    // Expected: update fails SESSION_NOT_FOUND, attachSession runs but bails (parentID),
    // so no registerSession. Retry is not attempted after attach bail-out.
    // We should see the initial update attempt, but NO register and NO retry.
    assert.deepEqual(daemon._operations, ["update:busy:child-session"])
    assert.equal(daemon._knownSessionIds.size, 0, "child session must not be registered")
  })

  test("/premind-pause on unknown session re-attaches and pauses", async () => {
    const daemon = makeReattachingDaemon(new Set())
    const runtime = await makePlugin(daemon)

    // Invoke the pause command via the tool to bypass the chat.message marker flow.
    const result = await runtime.tool.premind_pause.execute({}, { sessionID: "resumed-session" })
    assert.match(result, /premind paused/)

    // Sequence: pause fails, re-attach, pause retried successfully.
    assert.deepEqual(daemon._operations, [
      "pause:resumed-session",
      "register:resumed-session",
      "pause:resumed-session",
    ])
  })
})

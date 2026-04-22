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

  test("re-attach with a pending batch re-arms delivery (no stuck 0s toast)", async () => {
    // The reattach path should reset the idle clock and trigger a fresh delivery
    // cycle. Simulate opencode resuming a session that the daemon already has a
    // batch queued for.
    const daemon = makeReattachingDaemon(new Set())
    const pendingBatch = {
      batchId: "batch-reattach",
      sessionId: "resumed-session",
      reminderText: "<system-reminder>queued while absent</system-reminder>",
      events: [{} as never],
    }
    let pendingBatchRef: typeof pendingBatch | null = pendingBatch
    ;(daemon as unknown as { getPendingReminder: () => Promise<unknown> }).getPendingReminder = async () => ({ batch: pendingBatchRef })
    ;(daemon as unknown as { ackReminder: (p: { state: string }) => Promise<unknown> }).ackReminder = async ({ state }: { state: string }) => {
      if (state === "handed_off" || state === "confirmed") pendingBatchRef = null
    }

    const asyncPrompts: Array<{ sessionId: string; text: string }> = []
    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon as never,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/reattach" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: 0, // deliver immediately when re-armed
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

    // Fire session.idle for an unknown session — triggers withReattach -> attachSession(reattach).
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "resumed-session" } } })

    // Give microtasks a moment to flush.
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(asyncPrompts.length, 1, "reattach should have re-armed delivery and fired the pending batch")
    assert.match(asyncPrompts[0].text, /queued while absent/)
  })
})

// ---------------------------------------------------------------------------
// NotFoundError handling
// ---------------------------------------------------------------------------

describe("NotFoundError handling", () => {
  // The opencode SDK returns { error: NOT_FOUND } instead of throwing on 404.
  // These tests use the same return-not-throw pattern to match the real SDK.
  const NOT_FOUND = { name: "NotFoundError", data: { message: "not found" } }
  const NOT_FOUND_RESPONSE = { error: NOT_FOUND }

  const makeNotFoundPlugin = async (options: {
    promptAsyncNotFound?: boolean
    promptNotFound?: boolean
  }) => {
    const operations: string[] = []
    let batchAvailable = true

    const daemon = {
      registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
      heartbeat: async () => undefined,
      release: async () => undefined,
      registerSession: async ({ sessionId }: { sessionId: string }) => {
        operations.push(`register:${sessionId}`)
      },
      updateSessionState: async () => undefined,
      unregisterSession: async (sessionId: string) => {
        operations.push(`unregister:${sessionId}`)
      },
      pauseSession: async () => undefined,
      resumeSession: async () => undefined,
      getPendingReminder: async (sessionId: string) => ({
        batch: batchAvailable
          ? {
              batchId: "b1",
              sessionId,
              reminderText: "<system-reminder>test</system-reminder>",
              events: [{}],
            }
          : null,
      }),
      ackReminder: async ({ state }: { state: string }) => {
        operations.push(`ack:${state}`)
        if (state === "handed_off" || state === "confirmed") batchAvailable = false
      },
      setGlobalDisabled: async (d: boolean) => ({ disabled: d }),
      getGlobalDisabled: async () => ({ disabled: false }),
      debugStatus: async () => ({ daemon: {}, activeClients: 1, activeSessions: 1, activeWatchers: 0, lastReapAt: null, lastReapCount: 0, sessions: [] }),
      _operations: operations,
    }

    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon as never,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/x" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: 0,
    })({
      directory: "/tmp/project",
      worktree: "/tmp/project",
      client: {
        session: {
          get: async () => ({ data: {} }),
          // Mimic the real SDK: return { error } instead of throwing.
          prompt: async () => options.promptNotFound ? NOT_FOUND_RESPONSE : undefined,
          promptAsync: async () => options.promptAsyncNotFound ? NOT_FOUND_RESPONSE : undefined,
        },
        tui: { showToast: async () => undefined },
      },
    } as never)

    const runtime = plugin as unknown as {
      config: (input: Record<string, unknown>) => Promise<void>
      event: (input: { event: unknown }) => Promise<void>
      "chat.message": (input: unknown, output: unknown) => Promise<void>
    }
    await runtime.config({})
    return { runtime, daemon }
  }

  test("promptAsync NotFoundError: session is unregistered and no ack:failed is sent", async () => {
    const { runtime, daemon } = await makeNotFoundPlugin({ promptAsyncNotFound: true })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "gone-session" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "gone-session" } } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // ack:handed_off fires before promptAsync, then the NotFoundError path should
    // NOT send ack:failed (session is gone — no point acking).
    assert.ok(daemon._operations.includes("ack:handed_off"), "should have started hand-off")
    assert.ok(!daemon._operations.includes("ack:failed"), "must NOT ack:failed on NotFoundError")
    // unregisterSession should be called to clean up the daemon record.
    assert.ok(daemon._operations.includes("unregister:gone-session"), "should unregister the gone session")
  })

  test("promptAsync NotFoundError: subsequent idle events do not retry delivery", async () => {
    const { runtime, daemon } = await makeNotFoundPlugin({ promptAsyncNotFound: true })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "gone-session" } } })
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "gone-session" } } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const ackCountAfterFirst = daemon._operations.filter((o) => o.startsWith("ack:")).length
    // Fire another idle — should be a no-op (session no longer owned).
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "gone-session" } } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const ackCountAfterSecond = daemon._operations.filter((o) => o.startsWith("ack:")).length
    assert.equal(ackCountAfterFirst, ackCountAfterSecond, "no further acks after NotFoundError unregisters the session")
  })

  test("injectResponse NotFoundError: error does not propagate to the caller", async () => {
    const { runtime } = await makeNotFoundPlugin({ promptNotFound: true })

    // /premind-status injects a response via client.session.prompt.
    // If that throws NotFoundError it must be swallowed, not re-thrown.
    const registeredConfig: Record<string, unknown> = {}
    await runtime.config(registeredConfig)
    const commands = registeredConfig.command as Record<string, { template: string }>

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "gone-session" } } })

    // This should NOT throw even though prompt() will throw NotFoundError.
    await assert.doesNotReject(async () => {
      await runtime["chat.message"](
        { sessionID: "gone-session" },
        { message: { parts: [{ type: "text", text: commands["premind-status"].template }] }, parts: [{ type: "text", text: commands["premind-status"].template }] },
      )
    }, "NotFoundError from injectResponse must not propagate")
  })
})

// ---------------------------------------------------------------------------
// attachSession skips sessions that don't exist in opencode
// ---------------------------------------------------------------------------

describe("attachSession skips nonexistent sessions", () => {
  const makePlugin = async (sessionGetResponse: unknown) => {
    const operations: string[] = []
    const daemon = {
      registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
      heartbeat: async () => undefined,
      release: async () => undefined,
      registerSession: async ({ sessionId }: { sessionId: string }) => {
        operations.push(`register:${sessionId}`)
      },
      updateSessionState: async () => undefined,
      unregisterSession: async (sessionId: string) => { operations.push(`unregister:${sessionId}`) },
      pauseSession: async () => undefined,
      resumeSession: async () => undefined,
      getPendingReminder: async () => ({ batch: null }),
      ackReminder: async () => undefined,
      setGlobalDisabled: async (d: boolean) => ({ disabled: d }),
      getGlobalDisabled: async () => ({ disabled: false }),
      debugStatus: async () => ({ daemon: {}, activeClients: 0, activeSessions: 0, activeWatchers: 0, lastReapAt: null, lastReapCount: 0, sessions: [] }),
      _operations: operations,
    }

    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon as never,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/x" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: 0,
    })({
      directory: "/tmp/project",
      worktree: "/tmp/project",
      client: {
        session: {
          // Return the configured response for every session.get call.
          get: async () => sessionGetResponse,
          prompt: async () => undefined,
          promptAsync: async () => undefined,
        },
        tui: { showToast: async () => undefined },
      },
    } as never)

    const runtime = plugin as unknown as {
      config: (input: Record<string, unknown>) => Promise<void>
      event: (input: { event: unknown }) => Promise<void>
    }
    await runtime.config({})
    return { runtime, daemon }
  }

  test("session.created with error response does not register the session", async () => {
    // SDK returns { error: NotFoundError } when the session doesn't exist.
    const { runtime, daemon } = await makePlugin({ error: { name: "NotFoundError" } })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "ghost-session" } } })

    assert.ok(!daemon._operations.includes("register:ghost-session"), "must not register a nonexistent session")
  })

  test("session.created with missing data does not register the session", async () => {
    // data field absent (undefined), e.g. a session that was garbage-collected.
    const { runtime, daemon } = await makePlugin({ data: undefined })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "ghost-session-2" } } })

    assert.ok(!daemon._operations.includes("register:ghost-session-2"), "must not register when data is missing")
  })

  test("session.created with valid response registers normally", async () => {
    const { runtime, daemon } = await makePlugin({ data: {} })

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "real-session" } } })

    assert.ok(daemon._operations.includes("register:real-session"), "must register a real session")
  })
})

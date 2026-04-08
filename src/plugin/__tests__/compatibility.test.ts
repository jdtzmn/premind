import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.js"

describe("premind plugin compatibility harness", () => {
  test("matches expected OpenCode event and command flow", async () => {
    const prompts: Array<{ sessionId: string; text: string }> = []
    const outputs: string[] = []
    const acknowledgements: Array<{ batchId: string; state: string }> = []
    const operations: string[] = []

    const daemon = {
      registerClient: async () => ({ heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }),
      heartbeat: async () => undefined,
      release: async () => undefined,
      registerSession: async ({ sessionId }: { sessionId: string }) => {
        operations.push(`register:${sessionId}`)
      },
      updateSessionState: async ({ sessionId, busyState, branch }: { sessionId: string; busyState?: string; branch?: string }) => {
        operations.push(`update:${sessionId}:${busyState ?? "none"}:${branch ?? "none"}`)
      },
      unregisterSession: async (sessionId: string) => {
        operations.push(`unregister:${sessionId}`)
      },
      pauseSession: async (sessionId: string) => {
        operations.push(`pause:${sessionId}`)
      },
      resumeSession: async (sessionId: string) => {
        operations.push(`resume:${sessionId}`)
      },
      getPendingReminder: async (sessionId: string) => ({
        batch: {
          batchId: "batch-1",
          sessionId,
          reminderText: "<system-reminder>Incremental update</system-reminder>",
          events: [],
        },
      }),
      ackReminder: async ({ batchId, state }: { batchId: string; state: string }) => {
        acknowledgements.push({ batchId, state })
      },
      debugStatus: async () => ({
        daemon: { protocolVersion: 1, heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 },
        activeClients: 1,
        activeSessions: 1,
        activeWatchers: 1,
        sessions: [
          {
            sessionId: "session-1",
            repo: "acme/repo",
            branch: "feature/test",
            prNumber: 42,
            status: "active",
            busyState: "idle",
            pendingReminderCount: 1,
          },
        ],
      }),
    }

    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      writeOutput: (text) => {
        outputs.push(text)
      },
    })({
      directory: "/tmp/project",
      worktree: "/tmp/project",
      client: {
        session: {
          get: async () => ({ data: {} }),
          promptAsync: async ({ path, body }: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }) => {
            prompts.push({ sessionId: path.id, text: body.parts[0].text })
          },
        },
      },
    } as never)

    const runtime = plugin as {
      event: (input: { event: unknown }, extra?: unknown) => Promise<void>
      "chat.message": (input: unknown, extra?: unknown) => Promise<void>
      "command.execute.before": (input: unknown, extra?: unknown) => Promise<void>
    }

    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    await runtime.event({ event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } } })

    assert.equal(prompts.length, 1)
    assert.match(prompts[0].text, /premind:\/\/reminder\/batch-1/)
    assert.deepEqual(
      acknowledgements.map((entry) => entry.state),
      ["handed_off"],
    )

    await runtime["chat.message"]({
      sessionID: "session-1",
      message: { parts: [{ type: "text", text: `${prompts[0].text}` }] },
    })

    assert.deepEqual(
      acknowledgements.map((entry) => entry.state),
      ["handed_off", "confirmed"],
    )

    await runtime["command.execute.before"]({ command: "premind-status", sessionID: "session-1" })
    await runtime["command.execute.before"]({ command: "premind-pause", sessionID: "session-1" })
    await runtime["command.execute.before"]({ command: "premind-resume", sessionID: "session-1" })

    assert.match(outputs.join("\n"), /premind status/)
    assert.ok(operations.includes("pause:session-1"))
    assert.ok(operations.includes("resume:session-1"))
  })
})

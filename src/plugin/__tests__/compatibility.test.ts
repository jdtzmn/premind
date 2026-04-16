import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createPremindPlugin } from "../index.ts"

describe("premind plugin compatibility harness", () => {
  test("matches expected OpenCode event, command, and tool flow", async () => {
    const asyncPrompts: Array<{ sessionId: string; text: string }> = []
    const syncPrompts: Array<{ sessionId: string; text: string; noReply?: boolean }> = []
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

    const registeredConfig: Record<string, unknown> = {}

    const plugin = await createPremindPlugin({
      createDaemonClient: () => daemon,
      detectGit: async () => ({ repo: "acme/repo", branch: "feature/test" }),
      ensureDaemon: async () => {},
      idleDeliveryThresholdMs: 0,
    })({
      directory: "/tmp/project",
      worktree: "/tmp/project",
      client: {
        session: {
          get: async () => ({ data: {} }),
          prompt: async ({ path, body }: { path: { id: string }; body: { noReply?: boolean; parts: Array<{ type: "text"; text: string }> } }) => {
            syncPrompts.push({ sessionId: path.id, text: body.parts[0].text, noReply: body.noReply })
          },
          promptAsync: async ({ path, body }: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }) => {
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
      tool: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>
    }

    // 1. Config hook registers slash commands.
    await runtime.config(registeredConfig)
    assert.ok(registeredConfig.command, "config hook should register commands")
    const commands = registeredConfig.command as Record<string, { template: string; description: string }>
    assert.ok(commands["premind-status"], "should register premind-status command")
    assert.ok(commands["premind-pause"], "should register premind-pause command")
    assert.ok(commands["premind-resume"], "should register premind-resume command")

    // 2. Session creation triggers registration.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    assert.ok(operations.includes("register:session-1"))

    // 3. session.idle event triggers reminder injection.
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    assert.equal(asyncPrompts.length, 1)
    assert.match(asyncPrompts[0].text, /premind:\/\/reminder\/batch-1/)
    assert.deepEqual(
      acknowledgements.map((entry) => entry.state),
      ["handed_off"],
    )

    // 4. chat.message with marker confirms delivery.
    const reminderText = asyncPrompts[0].text
    await runtime["chat.message"](
      { sessionID: "session-1", messageID: "msg-1" },
      { message: { parts: [{ type: "text", text: reminderText }] }, parts: [] },
    )
    assert.deepEqual(
      acknowledgements.map((entry) => entry.state),
      ["handed_off", "confirmed"],
    )

    // 5. Slash command via chat.message: premind-status marker injects noReply and throws.
    const statusMarker = commands["premind-status"].template
    try {
      await runtime["chat.message"](
        { sessionID: "session-1" },
        { message: { parts: [{ type: "text", text: statusMarker }] }, parts: [{ type: "text", text: statusMarker }] },
      )
      assert.fail("expected throw for handled command")
    } catch (error) {
      assert.match((error as Error).message, /PREMIND_HANDLED/)
    }
    const statusPrompt = syncPrompts.find((p) => p.text.includes("premind status"))
    assert.ok(statusPrompt, "should have injected status response")
    assert.equal(statusPrompt.noReply, true, "status response should be noReply")

    // 6. Slash command via chat.message: premind-pause.
    const pauseMarker = commands["premind-pause"].template
    try {
      await runtime["chat.message"](
        { sessionID: "session-1" },
        { message: { parts: [{ type: "text", text: pauseMarker }] }, parts: [{ type: "text", text: pauseMarker }] },
      )
      assert.fail("expected throw for handled command")
    } catch (error) {
      assert.match((error as Error).message, /PREMIND_HANDLED/)
    }
    assert.ok(operations.includes("pause:session-1"))

    // 7. Slash command via chat.message: premind-resume.
    const resumeMarker = commands["premind-resume"].template
    try {
      await runtime["chat.message"](
        { sessionID: "session-1" },
        { message: { parts: [{ type: "text", text: resumeMarker }] }, parts: [{ type: "text", text: resumeMarker }] },
      )
      assert.fail("expected throw for handled command")
    } catch (error) {
      assert.match((error as Error).message, /PREMIND_HANDLED/)
    }
    assert.ok(operations.includes("resume:session-1"))

    // 8. Tools are registered and callable.
    assert.ok(runtime.tool.premind_status, "premind_status tool should exist")
    assert.ok(runtime.tool.premind_pause, "premind_pause tool should exist")
    assert.ok(runtime.tool.premind_resume, "premind_resume tool should exist")
    assert.ok(runtime.tool.premind_probe, "premind_probe tool should exist")

    const toolStatusResult = await runtime.tool.premind_status.execute({}, { sessionID: "session-1" })
    assert.match(toolStatusResult, /premind status/)

    const toolPauseResult = await runtime.tool.premind_pause.execute({}, { sessionID: "session-1" })
    assert.match(toolPauseResult, /premind paused/)

    const toolResumeResult = await runtime.tool.premind_resume.execute({}, { sessionID: "session-1" })
    assert.match(toolResumeResult, /premind resumed/)

    const toolProbeResult = await runtime.tool.premind_probe.execute({}, { sessionID: "session-1" })
    assert.match(toolProbeResult, /premind probe/)
    assert.match(toolProbeResult, /commands registered: yes/)

    // 9. session.deleted unregisters.
    await runtime.event({ event: { type: "session.deleted", properties: { sessionID: "session-1" } } })
    assert.ok(operations.includes("unregister:session-1"))
  })
})

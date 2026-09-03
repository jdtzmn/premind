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
      activateWorktree: async ({ sessionId, path }: { sessionId: string; path: string }) => {
        operations.push(`activate:${sessionId}:${path}`)
      },
      subscribe: async ({ sessionId, prNumber, repo }: { sessionId: string; prNumber: number; repo?: string }) => {
        operations.push(`subscribe:${sessionId}:${repo ?? "default"}:${prNumber}`)
      },
      unsubscribe: async ({ sessionId, prNumber, repo }: { sessionId: string; prNumber: number; repo?: string }) => {
        operations.push(`unsubscribe:${sessionId}:${repo ?? "default"}:${prNumber}`)
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
      setGlobalDisabled: async (disabled: boolean) => {
        operations.push(`setGlobalDisabled:${disabled}`)
        return { disabled }
      },
      getGlobalDisabled: async () => ({ disabled: false }),
      debugStatus: async () => ({
        daemon: { protocolVersion: 1, heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 },
        activeClients: 1,
        activeSessions: 1,
        activeWatchers: 1,
        lastReapAt: null,
        lastReapCount: 0,
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
    assert.equal(commands["premind-pause"], undefined)
    assert.equal(commands["premind-resume"], undefined)
    assert.ok(commands["premind-disable"], "should register premind-disable command")
    assert.ok(commands["premind-enable"], "should register premind-enable command")

    // 2. Session creation triggers registration.
    await runtime.event({ event: { type: "session.created", properties: { sessionID: "session-1" } } })
    assert.ok(operations.includes("register:session-1"))
    assert.ok(operations.includes("activate:session-1:/tmp/project"))

    // 3. session.idle event triggers reminder injection with immediate auto-confirm.
    await runtime.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    // scheduleDelivery fires deliverPendingReminder as a void promise when threshold=0;
    // yield to let the microtask queue drain so acks complete before we assert.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(asyncPrompts.length, 1)
    // Reminder text should no longer contain a marker suffix.
    assert.ok(!asyncPrompts[0].text.includes("premind://reminder/"), "reminder text must not contain marker suffix")
    assert.deepEqual(
      acknowledgements.map((entry) => entry.state),
      ["handed_off", "confirmed"],
      "delivery should auto-confirm immediately after promptAsync succeeds",
    )

    // 4. Slash command via chat.message: premind-status marker injects noReply and throws.
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


    // 7a. Slash command via chat.message: premind-disable.
    const disableMarker = commands["premind-disable"].template
    try {
      await runtime["chat.message"](
        { sessionID: "session-1" },
        { message: { parts: [{ type: "text", text: disableMarker }] }, parts: [{ type: "text", text: disableMarker }] },
      )
      assert.fail("expected throw for handled command")
    } catch (error) {
      assert.match((error as Error).message, /PREMIND_HANDLED/)
    }
    assert.ok(operations.includes("setGlobalDisabled:true"))

    // 7b. Slash command via chat.message: premind-enable.
    const enableMarker = commands["premind-enable"].template
    try {
      await runtime["chat.message"](
        { sessionID: "session-1" },
        { message: { parts: [{ type: "text", text: enableMarker }] }, parts: [{ type: "text", text: enableMarker }] },
      )
      assert.fail("expected throw for handled command")
    } catch (error) {
      assert.match((error as Error).message, /PREMIND_HANDLED/)
    }
    assert.ok(operations.includes("setGlobalDisabled:false"))

    // 8. Tools are registered and callable.
    assert.ok(runtime.tool.premind_status, "premind_status tool should exist")
    assert.equal(runtime.tool.premind_pause, undefined)
    assert.equal(runtime.tool.premind_resume, undefined)
    assert.ok(runtime.tool.premind_activate_worktree, "premind_activate_worktree tool should exist")
    assert.ok(runtime.tool.premind_subscribe, "premind_subscribe tool should exist")
    assert.ok(runtime.tool.premind_unsubscribe, "premind_unsubscribe tool should exist")
    assert.ok(runtime.tool.premind_disable, "premind_disable tool should exist")
    assert.ok(runtime.tool.premind_enable, "premind_enable tool should exist")
    assert.ok(runtime.tool.premind_probe, "premind_probe tool should exist")

    const toolStatusResult = await runtime.tool.premind_status.execute({}, { sessionID: "session-1" })
    assert.match(toolStatusResult, /premind status/)


    const toolActivateResult = await runtime.tool.premind_activate_worktree.execute(
      { path: "/tmp/other-worktree" },
      { sessionID: "session-1" },
    )
    assert.match(toolActivateResult, /activated worktree \/tmp\/other-worktree/)

    const toolSubscribeResult = await runtime.tool.premind_subscribe.execute(
      { prNumber: 13, repo: "acme/repo" },
      { sessionID: "session-1" },
    )
    assert.match(toolSubscribeResult, /subscribed to acme\/repo#13/)

    const toolUnsubscribeResult = await runtime.tool.premind_unsubscribe.execute(
      { prNumber: 13, repo: "acme/repo" },
      { sessionID: "session-1" },
    )
    assert.match(toolUnsubscribeResult, /unsubscribed from acme\/repo#13/)
    assert.ok(operations.includes("activate:session-1:/tmp/other-worktree"))
    assert.ok(operations.includes("subscribe:session-1:acme/repo:13"))
    assert.ok(operations.includes("unsubscribe:session-1:acme/repo:13"))

    const toolDisableResult = await runtime.tool.premind_disable.execute({}, { sessionID: "session-1" })
    assert.match(toolDisableResult, /premind disabled globally/)

    const toolEnableResult = await runtime.tool.premind_enable.execute({}, { sessionID: "session-1" })
    assert.match(toolEnableResult, /premind re-enabled globally/)

    const toolProbeResult = await runtime.tool.premind_probe.execute({}, { sessionID: "session-1" })
    assert.match(toolProbeResult, /premind probe/)
    assert.match(toolProbeResult, /commands registered: yes/)

    // 9. session.deleted unregisters.
    await runtime.event({ event: { type: "session.deleted", properties: { sessionID: "session-1" } } })
    assert.ok(operations.includes("unregister:session-1"))
  })
})

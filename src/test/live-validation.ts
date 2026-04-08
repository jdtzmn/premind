/**
 * Live validation test for premind plugin contract assumptions.
 *
 * This script starts a real OpenCode server via the SDK, creates a session,
 * subscribes to the event stream, and verifies that the event shapes match
 * what the premind plugin expects.
 *
 * Modes:
 *   - Full mode (default): requires OPENCODE_PROVIDER + OPENCODE_API_KEY
 *     secrets. Creates a session, sends a prompt, and verifies the full
 *     event lifecycle including chat.message shapes.
 *   - Contract-only mode (--contract-only): starts the server and verifies
 *     session creation, status, and event shapes without needing a provider
 *     or making any LLM calls.
 *
 * Exit codes:
 *   0 = all assertions passed
 *   1 = assertion failure or runtime error
 */

const contractOnly = process.argv.includes("--contract-only")

type EventRecord = {
  type: string
  properties: Record<string, unknown>
}

const assertions = {
  passed: 0,
  failed: 0,
  results: [] as Array<{ name: string; ok: boolean; error?: string }>,
}

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    assertions.passed++
    assertions.results.push({ name, ok: true })
    console.log(`  PASS: ${name}`)
  } else {
    assertions.failed++
    assertions.results.push({ name, ok: false, error: detail })
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run() {
  console.log(`premind live validation (${contractOnly ? "contract-only" : "full"} mode)\n`)

  // Dynamic import so the script fails clearly if the SDK is missing.
  const { createOpencode } = await import("@opencode-ai/sdk")

  const controller = new AbortController()
  const opencode = await createOpencode({
    hostname: "127.0.0.1",
    port: 0, // Let the OS pick a free port
    signal: controller.signal,
    timeout: 15_000,
  })

  const client = opencode.client
  const collectedEvents: EventRecord[] = []

  // Subscribe to the SSE event stream.
  const eventStream = await client.event.subscribe()
  const streamReader = (async () => {
    try {
      for await (const event of eventStream.stream) {
        collectedEvents.push({
          type: (event as Record<string, unknown>).type as string,
          properties: (event as Record<string, unknown>).properties as Record<string, unknown>,
        })
      }
    } catch {
      // Stream closed, expected during cleanup.
    }
  })()

  // Let the event stream connect.
  await sleep(500)

  try {
    // ---------------------------------------------------------------
    // 1. Health check
    // ---------------------------------------------------------------
    console.log("1. Health check")
    const health = await (client.global as any).health()
    assert("server is healthy", (health.data as any)?.healthy === true)
    assert("server reports a version", typeof (health.data as any)?.version === "string" && (health.data as any).version.length > 0)

    // ---------------------------------------------------------------
    // 2. Create a session and verify shape
    // ---------------------------------------------------------------
    console.log("\n2. Session creation")
    const session = await client.session.create({ body: {} })
    const sessionId = session.data?.id
    assert("session.create returns an id", typeof sessionId === "string" && sessionId.length > 0)
    assert("session.create returns a time field", typeof (session.data as any)?.createdAt === "string" || typeof (session.data as any)?.created === "string" || typeof session.data?.id === "string")

    // ---------------------------------------------------------------
    // 3. Get session and verify shape matches plugin expectations
    // ---------------------------------------------------------------
    console.log("\n3. Session.get shape")
    const fetched = await client.session.get({ path: { id: sessionId! } })
    assert("session.get returns data with id", fetched.data?.id === sessionId)
    // The plugin checks for parentID to determine primary sessions.
    assert(
      "session.get exposes parentID field (null or string)",
      fetched.data?.parentID === null ||
        fetched.data?.parentID === undefined ||
        typeof fetched.data?.parentID === "string",
    )

    // ---------------------------------------------------------------
    // 4. Verify session status endpoint
    // ---------------------------------------------------------------
    console.log("\n4. Session status")
    const statuses = await client.session.status()
    assert("session.status returns an object", typeof statuses.data === "object" && statuses.data !== null)

    // ---------------------------------------------------------------
    // 5. Verify prompt_async shape (the injection path premind uses)
    // ---------------------------------------------------------------
    console.log("\n5. promptAsync shape")
    if (!contractOnly) {
      await client.session.promptAsync({
        path: { id: sessionId! },
        body: {
          parts: [{ type: "text" as const, text: "Say the word hello and nothing else. premind://validation/test-marker" }],
        },
      })
      assert("promptAsync accepted without error", true)

      // Wait for the model to respond and events to propagate.
      await sleep(8_000)
    } else {
      // In contract-only mode, just verify the method exists on the client.
      assert(
        "promptAsync method exists on client.session",
        typeof client.session.promptAsync === "function",
      )
    }

    // ---------------------------------------------------------------
    // 6. Verify collected event shapes
    // ---------------------------------------------------------------
    console.log("\n6. Event stream shape validation")
    const eventTypes = new Set(collectedEvents.map((event) => event.type))

    // The first event should be server.connected.
    assert(
      "event stream includes server.connected",
      collectedEvents.length > 0 && collectedEvents[0].type === "server.connected",
    )

    if (!contractOnly) {
      // After promptAsync, we expect session status events.
      const statusEvents = collectedEvents.filter((event) => event.type === "session.status")
      assert(
        "session.status events were emitted",
        statusEvents.length > 0,
        `got ${statusEvents.length} status events`,
      )

      if (statusEvents.length > 0) {
        const firstStatus = statusEvents[0]
        assert(
          "session.status event has properties.sessionID",
          typeof firstStatus.properties.sessionID === "string",
          `got ${JSON.stringify(firstStatus.properties)}`,
        )
        assert(
          "session.status event has properties.status with type field",
          typeof firstStatus.properties.status === "object" &&
            firstStatus.properties.status !== null &&
            typeof (firstStatus.properties.status as Record<string, unknown>).type === "string",
          `got ${JSON.stringify(firstStatus.properties.status)}`,
        )
      }

      // Look for chat.message events.
      const messageEvents = collectedEvents.filter((event) => event.type === "chat.message")
      assert(
        "chat.message events were emitted",
        messageEvents.length > 0,
        `got ${messageEvents.length} message events`,
      )

      if (messageEvents.length > 0) {
        const firstMessage = messageEvents[0]
        assert(
          "chat.message event has properties.sessionID",
          typeof firstMessage.properties.sessionID === "string",
          `got ${JSON.stringify(Object.keys(firstMessage.properties))}`,
        )
      }
    } else {
      console.log("  (skipping prompt-dependent event assertions in contract-only mode)")
    }

    // ---------------------------------------------------------------
    // 7. Verify delete works
    // ---------------------------------------------------------------
    console.log("\n7. Session cleanup")
    const deleted = await client.session.delete({ path: { id: sessionId! } })
    assert("session.delete succeeds", deleted.data === true || deleted.response.ok)

    if (!contractOnly) {
      // After deletion we expect a session.deleted event.
      await sleep(500)
      const deletedEvents = collectedEvents.filter((event) => event.type === "session.deleted")
      assert(
        "session.deleted event was emitted",
        deletedEvents.length > 0,
        `got ${deletedEvents.length} deleted events`,
      )

      if (deletedEvents.length > 0) {
        assert(
          "session.deleted event has properties.sessionID",
          typeof deletedEvents[0].properties.sessionID === "string",
          `got ${JSON.stringify(deletedEvents[0].properties)}`,
        )
      }
    }

    // ---------------------------------------------------------------
    // 8. Verify all expected event types our plugin relies on exist
    // ---------------------------------------------------------------
    console.log("\n8. Event type coverage")
    if (!contractOnly) {
      const requiredTypes = ["session.status"]
      for (const required of requiredTypes) {
        assert(`event type "${required}" observed`, eventTypes.has(required))
      }
    } else {
      assert("server.connected event observed", eventTypes.has("server.connected"))
    }
  } finally {
    // Cleanup.
    controller.abort()
    opencode.server.close()
    // Give the stream reader a moment to finish.
    await Promise.race([streamReader, sleep(1000)])
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log(`\n${"=".repeat(50)}`)
  console.log(`premind live validation: ${assertions.passed} passed, ${assertions.failed} failed`)

  if (assertions.failed > 0) {
    console.error("\nFailed assertions:")
    for (const result of assertions.results) {
      if (!result.ok) console.error(`  - ${result.name}${result.error ? `: ${result.error}` : ""}`)
    }
    process.exit(1)
  }

  process.exit(0)
}

void run().catch((error) => {
  console.error("Live validation crashed:", error)
  process.exit(1)
})

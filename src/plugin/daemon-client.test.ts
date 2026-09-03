import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PremindDaemonClient } from "./daemon-client.ts"

type Request = { type: string; payload: Record<string, unknown> }

describe("PremindDaemonClient.ensureSessionControl", () => {
  test("falls back to session registration when an older daemon rejects the request", async () => {
    const client = new PremindDaemonClient()
    const requests: Request[] = []
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>
    }
    testClient.requestWithRetry = async (request) => {
      requests.push(request)
      if (request.type === "ensureSessionControl") {
        throw new Error("BAD_REQUEST: unsupported request type")
      }
      return undefined
    }

    await client.ensureSessionControl({
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      busyState: "idle",
      paused: true,
    })

    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.type, "ensureSessionControl")
    assert.equal(requests[1]?.type, "registerSession")
    assert.deepEqual(requests[1]?.payload, {
      clientId: client.clientId,
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      busyState: "idle",
      status: "paused",
    })
  })

  test("propagates non-compatibility control errors", async () => {
    const client = new PremindDaemonClient()
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>
    }
    testClient.requestWithRetry = async () => {
      throw new Error("CLIENT_NOT_FOUND: Unknown client")
    }

    await assert.rejects(
      client.ensureSessionControl({
        sessionId: "session-1",
        repo: "acme/repo",
        branch: "feature/x",
        isPrimary: true,
        busyState: "idle",
        paused: false,
      }),
      /CLIENT_NOT_FOUND/,
    )
  })
})

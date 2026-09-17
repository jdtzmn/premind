import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { PremindDaemonClient } from "./daemon-client.ts"
import type { ReminderBatch } from "../shared/schema.ts"

type Request = {
  type: string
  protocolVersion?: number
  sessionLease?: unknown
  payload: Record<string, unknown>
}


const readV1Fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../shared/protocol/__fixtures__/v1/${name}`, import.meta.url),
      "utf8",
    ),
  )
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

describe("PremindDaemonClient session leases", () => {
  test("claims, renews, and releases session ownership", async () => {
    const client = new PremindDaemonClient()
    const requests: Request[] = []
    const lease = {
      sessionId: "session-1",
      ownerInstanceId: "daemon-a",
      generation: 1,
      clientIncarnationNonce: client.clientId,
      leaseToken: "00000000-0000-4000-8000-000000000001",
      claimedAt: 1,
      expiresAt: 60_001,
    }
    const testClient = client as unknown as {
      protocolVersion: 2
      daemonInstanceId: string
      supportedOperations: Set<string>
      requestWithRetry: (request: Request) => Promise<unknown>
      withNegotiatedProtocol: (request: Request) => Record<string, unknown>
    }
    testClient.protocolVersion = 2
    testClient.daemonInstanceId = "daemon-a"
    testClient.supportedOperations = new Set([
      "claimSessionLease",
      "renewSessionLease",
      "releaseSessionLease",
    ])
    testClient.requestWithRetry = async (request) => {
      requests.push(request)
      if (request.type === "claimSessionLease") return { lease }
      if (request.type === "renewSessionLease") {
        return { lease: { ...lease, expiresAt: 120_001 } }
      }
      if (request.type === "releaseSessionLease") return { released: true }
      return undefined
    }

    await client.registerSession({
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    const fenced = testClient.withNegotiatedProtocol({
      type: "updateSessionState",
      protocolVersion: 1,
      payload: { sessionId: "session-1", busyState: "busy" },
    })
    assert.deepEqual(fenced.sessionLease, lease)
    await client.heartbeat()
    await client.release()

    assert.deepEqual(
      requests.map(({ type }) => type),
      [
        "claimSessionLease",
        "registerSession",
        "heartbeatClient",
        "renewSessionLease",
        "releaseSessionLease",
        "releaseClient",
      ],
    )
    const releaseRequest = requests.find(({ type }) => type === "releaseSessionLease")
    assert.equal(
      (releaseRequest?.payload.lease as { expiresAt?: number } | undefined)?.expiresAt,
      120_001,
    )
  })

  test("claims before an unfenced protocol-v2 session mutation", async () => {
    const client = new PremindDaemonClient()
    const lease = {
      sessionId: "session-1",
      ownerInstanceId: "daemon-a",
      generation: 1,
      clientIncarnationNonce: "client-a-1",
      leaseToken: "00000000-0000-4000-8000-000000000002",
      claimedAt: 1,
      expiresAt: 60_001,
    }
    const requests: Request[] = []
    const testClient = client as unknown as {
      clientId: string
      protocolVersion: number
      daemonInstanceId?: string
      supportedOperations: Set<string>
      request: (request: Request) => Promise<unknown>
    }
    testClient.clientId = "client-a-1"
    testClient.protocolVersion = 2
    testClient.daemonInstanceId = "daemon-a"
    testClient.supportedOperations = new Set([
      "claimSessionLease",
      "renewSessionLease",
      "transferSessionLease",
      "releaseSessionLease",
    ])
    testClient.request = async (request) => {
      requests.push(request)
      if (request.type === "claimSessionLease") {
        return { lease }
      }
      return { ok: true, protocolVersion: 2, result: { updated: true } }
    }

    await client.updateSessionState({ sessionId: "session-1", busyState: "busy" })

    assert.deepEqual(requests.map(({ type }) => type), [
      "claimSessionLease",
      "updateSessionState",
    ])
    assert.deepEqual(requests[1]?.sessionLease, lease)
  })
})

describe("subscription compatibility", () => {
  test("accepts the previous protocol-v1 response shape", async () => {
    const client = new PremindDaemonClient()
    const subscription = {
      subscriptionId: "subscription-1", sessionId: "session-1", repo: "acme/repo",
      prNumber: 42, source: "manual" as const, state: "active" as const,
      lastDeliveredEventSeq: 0, updatedAt: 1,
    }
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>
    }
    testClient.requestWithRetry = async () => ({ subscription })
    assert.deepEqual(
      await client.subscribe({ sessionId: "session-1", repo: "acme/repo", prNumber: 42 }),
      { subscription },
    )
  })
})

describe("reminder bundle compatibility", () => {
  test("falls back to one legacy batch when bundle operations are unavailable", async () => {
    const client = new PremindDaemonClient()
    const requests: Request[] = []
    const { batch } = readV1Fixture(
      "e43cba0-pre-bundle-pending-reminder.json",
    ) as { batch: ReminderBatch }
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>
    }
    testClient.requestWithRetry = async (request) => {
      requests.push(request)
      if (request.type === "claimReminderBundle" || request.type === "ackReminderBundle") {
        throw new Error("BAD_REQUEST: unsupported request type")
      }
      if (request.type === "getPendingReminder") return { batch }
      return undefined
    }

    const claimed = await client.claimReminderBundle(batch.sessionId)
    assert.ok(claimed.bundle)
    assert.deepEqual(claimed.bundle.batches, [batch])
    const acknowledged = await client.ackReminderBundle({
      sessionId: batch.sessionId,
      handoffId: claimed.bundle.handoffId,
      state: "confirmed",
    })

    assert.equal(acknowledged.acknowledged, 1)
    assert.deepEqual(
      requests.map(({ type }) => type),
      [
        "claimReminderBundle",
        "getPendingReminder",
        "ackReminder",
        "ackReminderBundle",
        "ackReminder",
      ],
    )
    assert.deepEqual(requests[2]?.payload, {
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      state: "handed_off",
    })
    assert.deepEqual(requests[4]?.payload, {
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      state: "confirmed",
    })
  })

  test("adapts the previous protocol-v1 bundle response shape", async () => {
    const client = new PremindDaemonClient()
    const requests: Request[] = []
    const { batches } = readV1Fixture(
      "9e84f2d-first-bundle-claim.json",
    ) as { batches: ReminderBatch[] }
    const sessionId = batches[0]!.sessionId
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>
    }
    testClient.requestWithRetry = async (request) => {
      requests.push(request)
      if (request.type === "claimReminderBundle") return { batches }
      if (
        request.type === "ackReminderBundle" &&
        "handoffId" in request.payload
      ) {
        throw new Error("BAD_REQUEST: legacy acknowledgement shape")
      }
      if (request.type === "ackReminderBundle") return { acknowledged: 2 }
      return undefined
    }

    const claimed = await client.claimReminderBundle(sessionId)
    assert.ok(claimed.bundle)
    assert.deepEqual(claimed.bundle.batches, batches)
    const acknowledged = await client.ackReminderBundle({
      sessionId,
      handoffId: claimed.bundle.handoffId,
      state: "confirmed",
    })

    assert.equal(acknowledged.acknowledged, 2)
    const acknowledgements = requests.filter(({ type }) => type === "ackReminderBundle")
    assert.equal(acknowledgements.length, 2)
    assert.deepEqual(acknowledgements.at(-1)?.payload, {
      sessionId,
      state: "confirmed",
    })
    assert.equal(requests.some(({ type }) => type === "ackReminder"), false)
  })

  test("accepts the tokenized protocol-v1 bundle response shape", async () => {
    const fixture = readV1Fixture(
      "0a309df-tokenized-bundle-claim.json",
    ) as {
      bundle: { handoffId: string; batches: ReminderBatch[] }
    }
    const client = new PremindDaemonClient()
    const testClient = client as unknown as {
      requestWithRetry: () => Promise<unknown>
    }
    testClient.requestWithRetry = async () => fixture

    const claimed = await client.claimReminderBundle(
      fixture.bundle.batches[0]!.sessionId,
    )

    assert.deepEqual(claimed, fixture)
  })
})

describe("PremindDaemonClient.debugStatus", () => {
  test("normalizes a pre-host protocol-v1 response", async () => {
    const fixture = readV1Fixture(
      "a75d55f-pre-host-debug-status.json",
    )
    const client = new PremindDaemonClient()
    const testClient = client as unknown as {
      requestWithRetry: () => Promise<unknown>
    }
    testClient.requestWithRetry = async () => fixture

    const result = await client.debugStatus()

    assert.equal(result.sessions[0]?.host, "unknown")
    assert.equal(result.sessions[0]?.sessionId, "session-pre-host")
  })
})

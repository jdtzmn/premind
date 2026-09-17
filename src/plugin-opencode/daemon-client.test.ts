import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { PremindDaemonClient } from "./daemon-client.ts"
import type { ReminderBatch } from "../shared/schema.ts"

type Request = { type: string; payload: Record<string, unknown> }


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

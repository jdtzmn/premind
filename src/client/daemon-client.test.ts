import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { PremindDaemonClient } from "./daemon-client.ts";
import type { ReminderBatch } from "../shared/schema.ts";

type Request = { type: string; payload: Record<string, unknown> };

const createClient = () =>
  new PremindDaemonClient({ ensureDaemon: async () => undefined });

describe("PremindDaemonClient.ensureSessionControl", () => {
  test("falls back to session registration when an older daemon rejects the request", async () => {
    const client = createClient();
    const requests: Request[] = [];
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>;
    };
    testClient.requestWithRetry = async (request) => {
      requests.push(request);
      if (request.type === "ensureSessionControl") {
        throw new Error("BAD_REQUEST: unsupported request type");
      }
      return undefined;
    };

    await client.ensureSessionControl({
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      busyState: "idle",
      paused: true,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.type, "ensureSessionControl");
    assert.equal(requests[1]?.type, "registerSession");
    assert.deepEqual(requests[1]?.payload, {
      clientId: client.clientId,
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      busyState: "idle",
      status: "paused",
    });
  });

  test("propagates non-compatibility control errors", async () => {
    const client = createClient();
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>;
    };
    testClient.requestWithRetry = async () => {
      throw new Error("CLIENT_NOT_FOUND: Unknown client");
    };

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
    );
  });
});

describe("reminder bundle compatibility", () => {
  test("falls back to one legacy batch when bundle operations are unavailable", async () => {
    const client = createClient();
    const requests: Request[] = [];
    const batch = {
      batchId: "batch-1",
      sessionId: "session-1",
      reminderText: "Reminder",
      events: [],
    };
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>;
    };
    testClient.requestWithRetry = async (request) => {
      requests.push(request);
      if (
        request.type === "claimReminderBundle" ||
        request.type === "ackReminderBundle"
      ) {
        throw new Error("BAD_REQUEST: unsupported request type");
      }
      if (request.type === "getPendingReminder") return { batch };
      return undefined;
    };

    const claimed = await client.claimReminderBundle("session-1");
    assert.ok(claimed.bundle);
    assert.deepEqual(claimed.bundle.batches, [batch]);
    const acknowledged = await client.ackReminderBundle({
      sessionId: "session-1",
      handoffId: claimed.bundle.handoffId,
      state: "confirmed",
    });

    assert.equal(acknowledged.acknowledged, 1);
    assert.deepEqual(
      requests.map(({ type }) => type),
      [
        "claimReminderBundle",
        "getPendingReminder",
        "ackReminder",
        "ackReminderBundle",
        "ackReminder",
      ],
    );
    assert.deepEqual(requests[2]?.payload, {
      batchId: "batch-1",
      sessionId: "session-1",
      state: "handed_off",
    });
    assert.deepEqual(requests[4]?.payload, {
      batchId: "batch-1",
      sessionId: "session-1",
      state: "confirmed",
    });
  });

  test("adapts the previous protocol-v1 bundle response shape", async () => {
    const client = createClient();
    const requests: Request[] = [];
    const batches = ["batch-1", "batch-2"].map((batchId) => ({
      batchId,
      sessionId: "session-1",
      reminderText: batchId,
      events: [],
    }));
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>;
    };
    testClient.requestWithRetry = async (request) => {
      requests.push(request);
      if (request.type === "claimReminderBundle") return { batches };
      if (
        request.type === "ackReminderBundle" &&
        "handoffId" in request.payload
      ) {
        throw new Error("BAD_REQUEST: legacy acknowledgement shape");
      }
      if (request.type === "ackReminderBundle") return { acknowledged: 2 };
      return undefined;
    };

    const claimed = await client.claimReminderBundle("session-1");
    assert.ok(claimed.bundle);
    assert.deepEqual(claimed.bundle.batches, batches);
    const acknowledged = await client.ackReminderBundle({
      sessionId: "session-1",
      handoffId: claimed.bundle.handoffId,
      state: "confirmed",
    });

    assert.equal(acknowledged.acknowledged, 2);
    const acknowledgements = requests.filter(
      ({ type }) => type === "ackReminderBundle",
    );
    assert.equal(acknowledgements.length, 2);
    assert.deepEqual(acknowledgements.at(-1)?.payload, {
      sessionId: "session-1",
      state: "confirmed",
    });
    assert.equal(
      requests.some(({ type }) => type === "ackReminder"),
      false,
    );
  });
});

describe("PremindDaemonClient Codex operations", () => {
  test("uses the host-neutral atomic claim contract", async () => {
    const client = createClient();
    const requests: Request[] = [];
    const testClient = client as unknown as {
      requestWithRetry: (request: Request) => Promise<unknown>;
    };
    testClient.requestWithRetry = async (request) => {
      requests.push(request);
      switch (request.type) {
        case "registerCodexSession":
          return { registered: true, created: true };
        case "claimReminder":
          return { claim: null };
        case "settleReminderClaim":
          return { settled: true };
        case "releaseSessionOwner":
          return { released: true };
        default:
          throw new Error(`unexpected request: ${request.type}`);
      }
    };

    await client.registerCodexSession({
      sessionId: "codex:session-1",
      hostSessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/codex",
      busyState: "idle",
    });
    assert.deepEqual(
      await client.claimReminder({
        sessionId: "codex:session-1",
        boundary: "session_start",
      }),
      { claim: null },
    );
    assert.deepEqual(
      await client.settleReminderClaim({
        sessionId: "codex:session-1",
        batchId: "batch-1",
        handoffId: "00000000-0000-4000-8000-000000000000",
        outcome: "failed",
        failureReason: "hook exited",
      }),
      { settled: true },
    );
    assert.deepEqual(await client.releaseSessionOwner("codex:session-1"), {
      released: true,
    });
    assert.deepEqual(
      requests.map((request) => request.type),
      [
        "registerCodexSession",
        "claimReminder",
        "settleReminderClaim",
        "releaseSessionOwner",
      ],
    );
  });

  test("preserves actionable launcher failures", async () => {
    const client = new PremindDaemonClient({
      socketPath: `/tmp/premind-missing-${process.pid}.sock`,
      ensureDaemon: async () => {
        throw new Error("Premind requires Node.js 22.13.0 or newer");
      },
    });
    await assert.rejects(
      client.debugStatus(),
      /Premind requires Node\.js 22\.13\.0 or newer/,
    );
  });

  test("bounds no-retry cleanup requests", async () => {
    const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
    const directory = fs.mkdtempSync(
      path.join(temporaryRoot, "premind-client-timeout-"),
    );
    const socketPath = path.join(directory, "premind.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const client = new PremindDaemonClient({
        socketPath,
        ensureDaemon: async () => undefined,
        maxRetries: 0,
        requestTimeoutMs: 25,
      });
      const startedAt = Date.now();
      await assert.rejects(client.debugStatus(), /timed out after 25ms/);
      assert.ok(Date.now() - startedAt < 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("leaves ordinary operations without a client deadline", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "premind-client-slow-operation-"),
    );
    const socketPath = path.join(directory, "premind.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({ ok: true, protocolVersion: 1, result: {} })}\n`,
          );
        }, 50);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const client = new PremindDaemonClient({
        socketPath,
        ensureDaemon: async () => undefined,
        maxRetries: 0,
      });
      assert.equal(
        (client as unknown as { requestTimeoutMs?: number }).requestTimeoutMs,
        undefined,
      );
      await client.heartbeat();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

const readV1Fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../shared/protocol/__fixtures__/v1/${name}`, import.meta.url),
      "utf8",
    ),
  );

type LeaseRequest = Request & {
  protocolVersion?: number;
  sessionLease?: unknown;
};

describe("PremindDaemonClient protocol negotiation and session leases", () => {
  test("claims, renews, and releases a negotiated session lease", async () => {
    const client = createClient();
    const requests: LeaseRequest[] = [];
    const lease = {
      sessionId: "session-1",
      ownerInstanceId: "daemon-a",
      generation: 1,
      clientIncarnationNonce: client.clientId,
      leaseToken: "00000000-0000-4000-8000-000000000001",
      claimedAt: 1,
      expiresAt: 60_001,
    };
    const testClient = client as unknown as {
      protocolVersion: 2;
      daemonInstanceId: string;
      supportedOperations: Set<string>;
      requestWithRetry: (request: LeaseRequest) => Promise<unknown>;
      withNegotiatedProtocol: (
        request: LeaseRequest,
      ) => Record<string, unknown>;
    };
    testClient.protocolVersion = 2;
    testClient.daemonInstanceId = "daemon-a";
    testClient.supportedOperations = new Set([
      "claimSessionLease",
      "renewSessionLease",
      "releaseSessionLease",
    ]);
    testClient.requestWithRetry = async (request) => {
      requests.push(request);
      if (request.type === "claimSessionLease") return { lease };
      if (request.type === "renewSessionLease") {
        return { lease: { ...lease, expiresAt: 120_001 } };
      }
      if (request.type === "releaseSessionLease") return { released: true };
      return undefined;
    };

    await client.registerSession({
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    });
    const fenced = testClient.withNegotiatedProtocol({
      type: "updateSessionState",
      protocolVersion: 1,
      payload: { sessionId: "session-1", busyState: "busy" },
    });
    assert.deepEqual(fenced.sessionLease, lease);
    await client.heartbeat();
    await client.release();

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
    );
    const releaseRequest = requests.find(
      ({ type }) => type === "releaseSessionLease",
    );
    assert.equal(
      (releaseRequest?.payload.lease as { expiresAt?: number } | undefined)
        ?.expiresAt,
      120_001,
    );
  });

  test("claims before an unfenced protocol-v2 session mutation", async () => {
    const client = createClient();
    const lease = {
      sessionId: "session-1",
      ownerInstanceId: "daemon-a",
      generation: 1,
      clientIncarnationNonce: "client-a-1",
      leaseToken: "00000000-0000-4000-8000-000000000002",
      claimedAt: 1,
      expiresAt: 60_001,
    };
    const requests: LeaseRequest[] = [];
    const testClient = client as unknown as {
      clientId: string;
      protocolVersion: number;
      daemonInstanceId?: string;
      supportedOperations: Set<string>;
      request: (request: LeaseRequest) => Promise<unknown>;
    };
    testClient.clientId = "client-a-1";
    testClient.protocolVersion = 2;
    testClient.daemonInstanceId = "daemon-a";
    testClient.supportedOperations = new Set([
      "claimSessionLease",
      "renewSessionLease",
      "transferSessionLease",
      "releaseSessionLease",
    ]);
    testClient.request = async (request) => {
      requests.push(request);
      if (request.type === "claimSessionLease") return { lease };
      return { updated: true };
    };

    await client.updateSessionState({
      sessionId: "session-1",
      busyState: "busy",
    });

    assert.deepEqual(
      requests.map(({ type }) => type),
      ["claimSessionLease", "updateSessionState"],
    );
    assert.deepEqual(requests[1]?.sessionLease, lease);
  });
});

describe("protocol-v1 response compatibility", () => {
  test("accepts tokenized bundle claims", async () => {
    const fixture = readV1Fixture("0a309df-tokenized-bundle-claim.json") as {
      bundle: { handoffId: string; batches: ReminderBatch[] };
    };
    const client = createClient();
    const testClient = client as unknown as {
      requestWithRetry: () => Promise<unknown>;
    };
    testClient.requestWithRetry = async () => fixture;

    assert.deepEqual(
      await client.claimReminderBundle(fixture.bundle.batches[0]!.sessionId),
      fixture,
    );
  });

  test("normalizes debug status from before host fields", async () => {
    const client = createClient();
    const testClient = client as unknown as {
      requestWithRetry: () => Promise<unknown>;
    };
    testClient.requestWithRetry = async () =>
      readV1Fixture("a75d55f-pre-host-debug-status.json");

    const result = await client.debugStatus();
    assert.equal(result.sessions[0]?.host, "unknown");
    assert.equal(result.sessions[0]?.sessionId, "session-pre-host");
  });
});

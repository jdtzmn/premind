import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  PremindDaemonClient,
} from "./daemon-client.ts";
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

describe("debug status snapshot opt-in compatibility", () => {
  const response = { daemon: { protocolVersion: 1, heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }, globallyDisabled: false, activeClients: 0, activeSessions: 0, closedSessions: 0, activeWatchers: 0, lastReapAt: null, lastReapCount: 0, sessions: [] };
  test("requests snapshots only when opted in, then falls back on an older daemon", async () => {
    const client = createClient();
    const requests: Request[] = [];
    (client as unknown as { requestWithRetry: (request: Request) => Promise<unknown> }).requestWithRetry = async (request) => {
      requests.push(request);
      if (request.payload.includeSnapshots) throw new Error("BAD_REQUEST: unsupported payload");
      return response;
    };
    assert.deepEqual(await client.debugStatus({ includeSnapshots: true }), response);
    assert.deepEqual(requests.map((request) => request.payload), [{ includeSnapshots: true }, {}]);
    requests.length = 0;
    await client.debugStatus();
    assert.deepEqual(requests.map((request) => request.payload), [{}]);
  });
  test("non-compatibility errors are not masked by a retry", async () => {
    const client = createClient();
    (client as unknown as { requestWithRetry: (request: Request) => Promise<unknown> }).requestWithRetry = async () => { throw new Error("AUTH_FAILED: token invalid"); };
    await assert.rejects(client.debugStatus({ includeSnapshots: true }), /AUTH_FAILED/);
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

  test("bounds ordinary operations with a default deadline", async () => {
    await withSocketServer(
      (socket) => {
        socket.once("data", () => {
          setTimeout(() => socket.end(okResponse()), 50);
        });
      },
      async (socketPath) => {
        const client = new PremindDaemonClient({
          socketPath,
          ensureDaemon: async () => undefined,
          maxRetries: 0,
        });
        assert.equal(
          (client as unknown as { requestTimeoutMs: number }).requestTimeoutMs,
          DEFAULT_REQUEST_TIMEOUT_MS,
        );
        // A slow daemon that answers inside the deadline still succeeds.
        await client.heartbeat();
      },
    );
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
      initialized: boolean;
      protocolVersion: number;
      daemonInstanceId?: string;
      supportedOperations: Set<string>;
      request: (request: LeaseRequest) => Promise<unknown>;
    };
    testClient.clientId = "client-a-1";
    testClient.initialized = true;
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

describe("PremindDaemonClient connection loss", () => {
  test("starts a missing daemon before the first protocol handshake", async () => {
    const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
    const directory = fs.mkdtempSync(path.join(temporaryRoot, "premind-client-"));
    const socketPath = path.join(directory, "premind.sock");
    let ensureCalls = 0;
    const server = net.createServer((socket) =>
      socket.once("data", () => socket.end(okResponse())),
    );
    const client = new PremindDaemonClient({
      socketPath,
      ensureDaemon: async () => {
        ensureCalls++;
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      },
      maxRetries: 1,
      retryDelayMs: 0,
    });
    try {
      // No daemon is listening yet: the handshake must trigger ensureDaemon.
      await client.heartbeat();
      assert.equal(ensureCalls, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects when the daemon closes the connection without replying", async () => {
    await withSocketServer(
      (socket) => socket.once("data", () => socket.end()),
      async (socketPath) => {
        const client = new PremindDaemonClient({
          socketPath,
          ensureDaemon: async () => undefined,
          maxRetries: 0,
        });
        await assert.rejects(
          client.debugStatus(),
          /closed the connection before replying/,
        );
      },
    );
  });

  test("retries through ensureDaemon after the daemon drops a request", async () => {
    let connections = 0;
    await withSocketServer(
      (socket) => {
        connections++;
        const attempt = connections;
        socket.once("data", () => {
          // The first request dies with its daemon; later ones are answered.
          if (attempt === 1) socket.destroy();
          else socket.end(okResponse());
        });
      },
      async (socketPath) => {
        let ensureCalls = 0;
        const client = new PremindDaemonClient({
          socketPath,
          ensureDaemon: async () => {
            ensureCalls++;
          },
          maxRetries: 1,
          retryDelayMs: 0,
        });
        await client.heartbeat();
        assert.equal(ensureCalls, 1);
      },
    );
  });

  test("does not retry a timed-out request or probe for a new daemon", async () => {
    await withSocketServer(
      (socket) => socket.once("data", () => undefined),
      async (socketPath) => {
        let ensureCalls = 0;
        const client = new PremindDaemonClient({
          socketPath,
          ensureDaemon: async () => {
            ensureCalls++;
          },
          maxRetries: 3,
          retryDelayMs: 0,
          requestTimeoutMs: 25,
        });
        const startedAt = Date.now();
        await assert.rejects(client.debugStatus(), /timed out after 25ms/);
        assert.ok(Date.now() - startedAt < 200);
        assert.equal(ensureCalls, 0);
      },
    );
  });
});

const okResponse = () =>
  `${JSON.stringify({ ok: true, protocolVersion: 1, result: {} })}\n`;

const withSocketServer = async (
  onConnection: (socket: net.Socket) => void,
  run: (socketPath: string) => Promise<void>,
) => {
  const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "premind-client-"));
  const socketPath = path.join(directory, "premind.sock");
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

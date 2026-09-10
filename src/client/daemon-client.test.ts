import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { PremindDaemonClient } from "./daemon-client.ts";

type Request = { type: string; payload: Record<string, unknown> };

describe("PremindDaemonClient.ensureSessionControl", () => {
  test("falls back to session registration when an older daemon rejects the request", async () => {
    const client = new PremindDaemonClient();
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
    const client = new PremindDaemonClient();
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
    const client = new PremindDaemonClient();
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
    const client = new PremindDaemonClient();
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
    const client = new PremindDaemonClient();
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
});

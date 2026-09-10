import assert from "node:assert/strict";
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
});

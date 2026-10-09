import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { bootstrapResponseSchema } from "../../shared/protocol/bootstrap.ts";
import { LegacyV1GuardServer } from "../../shared/protocol/legacy-v1-guard-server.ts";
import { LegacyV1ProxyRouter } from "../../shared/protocol/legacy-v1-proxy.ts";
import { protocolV2ResponseSchema } from "../../shared/protocol/v2.ts";
import { PremindDaemonClient } from "../../client/daemon-client.ts";
import { StateStore } from "../persistence/store.ts";
import { IpcServer } from "./server.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const createServer = async () => {
  const dir = fs.mkdtempSync("/tmp/premind-ipc-bootstrap-test-");
  tempDirs.push(dir);
  const socketPath = path.join(dir, "premind.sock");
  const server = new IpcServer(new StateStore(path.join(dir, "state.db")));
  await server.listen(socketPath);
  return { server, socketPath };
};

const request = (socketPath: string, message: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });

const initialize = (protocols: { min: number; max: number }) => ({
  type: "initialize",
  bootstrapVersion: 1,
  payload: {
    client: {
      host: "pi",
      version: "0.2.0",
      commit: "client",
      incarnationNonce: "5fabf2b8-74cc-4aa7-be60-6f891786a22b",
    },
    protocols,
  },
});

describe("IpcServer protocol negotiation", () => {
  test("routes current clients from the historical socket to the modern server", async () => {
    const dir = fs.mkdtempSync("/tmp/premind-ipc-route-test-");
    tempDirs.push(dir);
    const historicalSocketPath = path.join(dir, "premind.sock");
    const modernSocketPath = path.join(dir, "premind-modern-epoch-1.sock");
    const server = new IpcServer(new StateStore(path.join(dir, "state.db")));
    const proxy = new LegacyV1ProxyRouter(server.store, server.daemonInstanceId, (routed) =>
      server.handleRequest(routed),
    );
    server.advertiseSocketPath(modernSocketPath);
    const guard = new LegacyV1GuardServer(proxy, (value) => server.bootstrap(value));
    await guard.listen(historicalSocketPath);
    await server.listen(modernSocketPath);
    const client = new PremindDaemonClient({
      host: "pi",
      socketPath: historicalSocketPath,
      ensureDaemon: async () => {},
    });
    try {
      await client.registerClient("/tmp/project", "test");
      assert.equal(client.selectedProtocolVersion, 2);
      for (const socketPath of [historicalSocketPath, modernSocketPath]) {
        assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
      }
      // Operations outside the frozen v1 allowlist only succeed on the modern socket.
      await client.registerSession({
        sessionId: "routed-session",
        repo: "acme/repo",
        branch: "feature/routed",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      });
      await client.deleteSession("routed-session");
      // v1 would fall back to unregistering, which only detaches the session.
      assert.equal(server.store.getSession("routed-session")?.status, "closed");
      const status = await client.debugStatus();
      assert.equal(status.daemon.protocolVersion, 2);
      // Historical protocol-v1 clients keep using the frozen proxy.
      const legacy = (await request(historicalSocketPath, {
        type: "debugStatus",
        protocolVersion: 1,
        payload: {},
      })) as { ok: boolean; protocolVersion: number };
      assert.deepEqual([legacy.ok, legacy.protocolVersion], [true, 1]);
    } finally {
      await client.release();
      await guard.close();
      await server.close(modernSocketPath);
    }
  });

  test("negotiates protocol v2 through permanent bootstrap v1", async () => {
    const { server, socketPath } = await createServer();
    try {
      const response = bootstrapResponseSchema.parse(
        await request(socketPath, initialize({ min: 1, max: 2 })),
      );

      assert.equal(response.ok, true);
      if (!response.ok) assert.fail("expected bootstrap success");
      assert.equal(response.result.protocols.selected, 2);
      assert.equal(response.result.daemon.socketPath, socketPath);
      assert.equal(response.result.daemon.lifecycleState, "ready");
    } finally {
      await server.close(socketPath);
    }
  });

  test("a current client negotiates v2 before normal operations", async () => {
    const { server, socketPath } = await createServer();
    const client = new PremindDaemonClient({
		host: "pi",
		socketPath,
		ensureDaemon: async () => {},
	});
    try {
      await client.registerClient("/tmp/project", "test");
      const status = await client.debugStatus();

      assert.equal(client.selectedProtocolVersion, 2);
      assert.equal(status.daemon.protocolVersion, 2);
    } finally {
      await client.release();
      await server.close(socketPath);
    }
  });

  test("falls back to protocol v1 when a legacy daemon rejects initialize", async () => {
    const dir = fs.mkdtempSync("/tmp/premind-ipc-legacy-test-");
    tempDirs.push(dir);
    const socketPath = path.join(dir, "premind.sock");
    const requests: Array<{ type: string; protocolVersion?: number }> = [];
    const legacyServer = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        const message = JSON.parse(String(chunk).trim()) as {
          type: string;
          protocolVersion?: number;
        };
        requests.push(message);
        if (message.type === "initialize") {
          socket.end(
            `${JSON.stringify({
              ok: false,
              protocolVersion: 1,
              error: { code: "BAD_REQUEST", message: "unsupported request type" },
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            ok: true,
            protocolVersion: 1,
            result:
              message.type === "registerClient"
                ? {
                    heartbeatMs: 10_000,
                    leaseTtlMs: 30_000,
                    idleShutdownGraceMs: 15_000,
                  }
                : { released: true },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => legacyServer.listen(socketPath, resolve));
    const client = new PremindDaemonClient({
		host: "pi",
		socketPath,
		ensureDaemon: async () => {},
	});

    try {
      await client.registerClient("/tmp/project", "test");
      assert.equal(client.selectedProtocolVersion, 1);
      assert.deepEqual(
        requests.slice(0, 2).map(({ type, protocolVersion }) => ({
          type,
          protocolVersion,
        })),
        [
          { type: "initialize", protocolVersion: undefined },
          { type: "registerClient", protocolVersion: 1 },
        ],
      );
      await client.release();
    } finally {
      await new Promise<void>((resolve) => legacyServer.close(() => resolve()));
    }
  });

  test("returns a bootstrap-only error when protocols do not overlap", async () => {
    const { server, socketPath } = await createServer();
    try {
      const response = bootstrapResponseSchema.parse(
        await request(socketPath, initialize({ min: 7, max: 7 })),
      );

      assert.equal(response.ok, false);
      if (response.ok) assert.fail("expected bootstrap failure");
      assert.equal(response.error.code, "PROTOCOL_UNSUPPORTED");
      assert.equal("protocolVersion" in response, false);
    } finally {
      await server.close(socketPath);
    }
  });

  test("serves the same debug operation through immutable v1 and v2 envelopes", async () => {
    const { server, socketPath } = await createServer();
    try {
      const v1 = (await request(socketPath, {
        type: "debugStatus",
        protocolVersion: 1,
        payload: {},
      })) as { ok: boolean; protocolVersion: number };
      const v2 = protocolV2ResponseSchema.parse(
        await request(socketPath, {
          type: "debugStatus",
          protocolVersion: 2,
          payload: {},
        }),
      );

      assert.equal(v1.ok, true);
      assert.equal(v1.protocolVersion, 1);
      assert.equal(v2.ok, true);
      assert.equal(v2.protocolVersion, 2);
    } finally {
      await server.close(socketPath);
    }
  });
});

const createOwnedServer = (dir: string) =>
	new IpcServer(new StateStore(path.join(dir, "premind.db")));

test("closing leaves a socket that another daemon has since bound", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-ipc-server-"));
	const socketPath = path.join(dir, "premind.sock");
	const orphan = createOwnedServer(dir);
	await orphan.listen(socketPath);

	// Another daemon replaced the socket file, stranding the first one.
	fs.rmSync(socketPath);
	const owner = net.createServer();
	await new Promise<void>((resolve) => owner.listen(socketPath, resolve));
	try {
		await orphan.close(socketPath);
		assert.equal(fs.existsSync(socketPath), true);
	} finally {
		await new Promise<void>((resolve) => owner.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("closing removes the daemon's own socket", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-ipc-server-"));
	const socketPath = path.join(dir, "premind.sock");
	const server = createOwnedServer(dir);
	try {
		await server.listen(socketPath);
		await server.close(socketPath);
		assert.equal(fs.existsSync(socketPath), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a paused session stays paused after its client reconnects to a new daemon", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-ipc-reconnect-"));
  const socketPath = path.join(dir, "premind.sock");
  const dbPath = path.join(dir, "premind.db");
  let server = new IpcServer(new StateStore(dbPath));
  await server.listen(socketPath);
  let serving = true;
  const client = new PremindDaemonClient({
    host: "pi",
    socketPath,
    retryDelayMs: 0,
    // Stands in for a launcher: starts a fresh daemon on the same state.
    ensureDaemon: async () => {
      if (serving) return;
      // Like daemon startup, recovery detaches every process-owned session.
      const store = new StateStore(dbPath);
      store.recoverFromRestart();
      server = new IpcServer(store);
      await server.listen(socketPath);
      serving = true;
    },
  });
  try {
    await client.registerClient(dir, "test");
    await client.ensureSessionControl({
      sessionId: "paused-session",
      host: "pi",
      repo: "acme/repo",
      branch: "main",
      isPrimary: true,
      busyState: "idle",
      paused: false,
    });
    await client.registerSession({
      sessionId: "registered-session",
      host: "pi",
      repo: "acme/repo",
      branch: "main",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    });
    for (const sessionId of ["paused-session", "registered-session"]) {
      await client.pauseSession(sessionId);
      assert.equal(server.store.isSessionPaused(sessionId), true);
    }

    // The daemon is replaced; the client's next request reconnects and
    // re-registers its sessions with their original payloads.
    await server.close(socketPath);
    serving = false;
    await client.heartbeat();
    for (const sessionId of ["paused-session", "registered-session"]) {
      assert.equal(server.store.getSession(sessionId)?.status, "active", sessionId);
      assert.equal(server.store.isSessionPaused(sessionId), true, sessionId);
    }
  } finally {
    await client.release();
    await server.close(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clients that disconnect before their reply never crash the daemon", async () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "premind-ipc-epipe-"));
  const historicalSocketPath = path.join(dir, "premind.sock");
  const modernSocketPath = path.join(dir, "modern.sock");
  const server = new IpcServer(new StateStore(path.join(dir, "premind.db")));
  const guard = new LegacyV1GuardServer(
    new LegacyV1ProxyRouter(server.store, server.daemonInstanceId, (routed) =>
      server.handleRequest(routed),
    ),
    (value) => server.bootstrap(value),
  );
  await guard.listen(historicalSocketPath);
  await server.listen(modernSocketPath);
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => crashes.push(error);
  process.on("uncaughtException", onCrash);
  try {
    // Like a liveness probe or a timed-out request: send, then hang up at once.
    const hangUps = [historicalSocketPath, modernSocketPath].flatMap((socketPath) =>
      Array.from({ length: 25 }, () =>
        new Promise<void>((resolve) => {
          const socket = net.createConnection(socketPath, () => {
            socket.write(
              `${JSON.stringify({ type: "debugStatus", protocolVersion: 1, payload: {} })}\n`,
              () => {
                socket.destroy();
                resolve();
              },
            );
          });
          socket.on("error", () => resolve());
        }),
      ),
    );
    await Promise.all(hangUps);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(crashes, []);
    for (const socketPath of [historicalSocketPath, modernSocketPath]) {
      const response = (await request(socketPath, {
        type: "debugStatus",
        protocolVersion: 1,
        payload: {},
      })) as { ok: boolean };
      assert.equal(response.ok, true, socketPath);
    }
  } finally {
    process.off("uncaughtException", onCrash);
    await guard.close();
    await server.close(modernSocketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

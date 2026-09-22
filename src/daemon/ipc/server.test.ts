import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { bootstrapResponseSchema } from "../../shared/protocol/bootstrap.ts";
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

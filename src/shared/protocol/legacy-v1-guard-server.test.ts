import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { Router } from "../../daemon/ipc/router.ts";
import { StateStore } from "../../daemon/persistence/store.ts";
import { LegacyV1GuardServer } from "./legacy-v1-guard-server.ts";
import { LegacyV1ProxyRouter } from "./legacy-v1-proxy.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const request = (socketPath: string, value: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${value}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });

describe("legacy protocol-v1 guard server", () => {
  test("binds the historical socket and returns parseable frozen errors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-v1-guard-test-"));
    directories.push(directory);
    const socketPath = path.join(directory, "premind.sock");
    const store = new StateStore(path.join(directory, "modern.db"));
    const router = new Router(store);
    const proxy = new LegacyV1ProxyRouter(store, "daemon-a", (modernRequest) =>
      router.handle(modernRequest),
    );
    const guard = new LegacyV1GuardServer(proxy);
    await guard.listen(socketPath);
    try {
      assert.deepEqual(await request(socketPath, "not-json"), {
        ok: false,
        protocolVersion: 1,
        error: { code: "BAD_REQUEST", message: "Malformed protocol-v1 request" },
      });
      assert.deepEqual(
        await request(
          socketPath,
          JSON.stringify({
            type: "pruneClosedSessions",
            protocolVersion: 1,
            payload: {},
          }),
        ),
        {
          ok: false,
          protocolVersion: 1,
          error: {
            code: "BAD_REQUEST",
            message: "Unsupported protocol-v1 operation: pruneClosedSessions",
          },
        },
      );
    } finally {
      await guard.close();
      store.close();
    }
    assert.equal(fs.existsSync(socketPath), false);
  });
});

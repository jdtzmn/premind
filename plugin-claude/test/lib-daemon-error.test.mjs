import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { request } from "../bin/lib.mjs";

for (const code of ["SESSION_NOT_FOUND", "SESSION_INACTIVE", "SESSION_BUSY", "SESSION_MOVED", "ENOENT"]) {
  test(`Claude request preserves ${code} as a daemon response`, async () => {
    const directory = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "premind-claude-error-"));
    const socketPath = path.join(directory, "test.sock");
    let connections = 0;
    const message = "daemon rejected operation mentioning ECONNREFUSED";
    const server = net.createServer((socket) => {
      connections++;
      socket.once("data", () => socket.end(`${JSON.stringify({ ok: false, protocolVersion: 1, error: { code, message } })}\n`));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await assert.rejects(request("updateSessionState", { sessionId: "session-1" }, socketPath), (error) => {
        assert.equal(error.domain, "daemon");
        assert.equal(error.code, code);
        assert.equal(error.daemonMessage, message);
        assert.equal(error.message, `${code}: ${message}`);
        return true;
      });
      assert.equal(connections, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  acquireDaemonStartLock,
  probeDaemon,
  releaseDaemonStartLock,
} from "./daemon-startup.ts";

const tempPaths: string[] = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync("/tmp/premind-daemon-startup-test-");
  tempPaths.push(dir);
  return dir;
};

const listen = async (socketPath: string, operations?: readonly string[]) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          ok: true,
          protocolVersion: 1,
          result: {
            daemon: {
              protocolVersion: 1,
              ...(operations ? { operations } : {}),
            },
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
};

afterEach(async () => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon start lock is shared and releases only its own acquisition", () => {
  const stateDir = createTempDir();
  const first = acquireDaemonStartLock({ stateDir });
  assert.ok(first);
  assert.equal(acquireDaemonStartLock({ stateDir }), undefined);

  releaseDaemonStartLock(first);
  const second = acquireDaemonStartLock({ stateDir });
  assert.ok(second);
  releaseDaemonStartLock(second);
});

test("Claude probe requires advertised Claude IPC operations while allowing legacy generic probes", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const server = await listen(
    socketPath,
    CLAUDE_REQUIRED_DAEMON_OPERATIONS.slice(0, -1),
  );

  try {
    assert.equal(await probeDaemon(socketPath), true);
    assert.equal(
      await probeDaemon(socketPath, CLAUDE_REQUIRED_DAEMON_OPERATIONS),
      false,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const compatibleServer = await listen(
    socketPath,
    CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  );
  try {
    assert.equal(
      await probeDaemon(socketPath, CLAUDE_REQUIRED_DAEMON_OPERATIONS),
      true,
    );
  } finally {
    await new Promise<void>((resolve) =>
      compatibleServer.close(() => resolve()),
    );
  }
});

test("Codex probe rejects daemons without atomic claim capabilities", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const incompleteServer = await listen(
    socketPath,
    CODEX_REQUIRED_DAEMON_OPERATIONS.slice(0, -1),
  );

  try {
    assert.equal(
      await probeDaemon(socketPath, CODEX_REQUIRED_DAEMON_OPERATIONS),
      false,
    );
  } finally {
    await new Promise<void>((resolve) =>
      incompleteServer.close(() => resolve()),
    );
  }

  const compatibleServer = await listen(
    socketPath,
    CODEX_REQUIRED_DAEMON_OPERATIONS,
  );
  try {
    assert.equal(
      await probeDaemon(socketPath, CODEX_REQUIRED_DAEMON_OPERATIONS),
      true,
    );
  } finally {
    await new Promise<void>((resolve) =>
      compatibleServer.close(() => resolve()),
    );
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  acquireDaemonStartLock,
  inspectDaemon,
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

test("classifies unreachable, malformed, and capability-incompatible daemons", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  assert.deepEqual(await inspectDaemon(socketPath), { status: "unreachable" });

  const incomplete = await listen(socketPath, ["registerCodexSession"]);
  try {
    const result = await inspectDaemon(
      socketPath,
      CODEX_REQUIRED_DAEMON_OPERATIONS,
    );
    assert.equal(result.status, "incompatible");
    if (result.status === "incompatible") {
      assert.deepEqual(result.missingOperations, [
        "claimReminder",
        "settleReminderClaim",
        "releaseSessionOwner",
      ]);
    }
  } finally {
    await new Promise<void>((resolve) => incomplete.close(() => resolve()));
  }

  const malformed = net.createServer((socket) => {
    socket.once("data", () => socket.end("not-json\n"));
  });
  await new Promise<void>((resolve) => malformed.listen(socketPath, resolve));
  try {
    const result = await inspectDaemon(socketPath);
    assert.equal(result.status, "incompatible");
    if (result.status === "incompatible") {
      assert.match(result.reason, /invalid JSON/);
    }
  } finally {
    await new Promise<void>((resolve) => malformed.close(() => resolve()));
  }

  const silent = net.createServer((socket) => {
    socket.once("data", () => undefined);
  });
  await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
  try {
    const result = await inspectDaemon(socketPath, [], 25);
    assert.equal(result.status, "unresponsive");
    if (result.status === "unresponsive") {
      assert.match(result.reason, /timed out/);
    }
  } finally {
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }

  const reset = net.createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve) => reset.listen(socketPath, resolve));
  try {
    const result = await inspectDaemon(socketPath);
    assert.equal(result.status, "unresponsive");
    if (result.status === "unresponsive") {
      assert.match(result.reason, /closed/);
    }
  } finally {
    await new Promise<void>((resolve) => reset.close(() => resolve()));
  }

  const legacy = await listen(socketPath);
  try {
    assert.deepEqual(await inspectDaemon(socketPath), {
      status: "compatible",
      protocolVersion: 1,
      operations: [],
    });
  } finally {
    await new Promise<void>((resolve) => legacy.close(() => resolve()));
  }
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

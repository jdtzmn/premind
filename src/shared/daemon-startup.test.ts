import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  acquireDaemonLock,
  acquireDaemonStartLock,
  daemonLockStatus,
  formatDaemonLockStatus,
  holdsDaemonLock,
  inspectDaemon,
  isDaemonStarting,
  probeDaemon,
  releaseDaemonLock,
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

// A PID far above any macOS or Linux default limit is never a live process.
const DEAD_PID = 2 ** 30;

const writeDaemonLock = (stateDir: string, pid: number, createdAt: number) =>
  fs.writeFileSync(
    path.join(stateDir, "daemon.lock"),
    `${pid}:${createdAt}:previous-owner`,
  );

test("only one daemon holds the daemon lock while it is alive", async () => {
  const stateDir = createTempDir();
  const first = await acquireDaemonLock({ stateDir });
  assert.ok(first);
  assert.equal(isDaemonStarting(stateDir), true);
  // A second daemon must lose even though the first is not serving yet.
  assert.equal(
    await acquireDaemonLock({ stateDir, isServing: async () => false }),
    undefined,
  );

  releaseDaemonLock(first);
  assert.equal(isDaemonStarting(stateDir), false);
  const second = await acquireDaemonLock({ stateDir });
  assert.ok(second);
  releaseDaemonLock(second);
});

test("reclaims the daemon lock from a dead owner", async () => {
  const stateDir = createTempDir();
  writeDaemonLock(stateDir, DEAD_PID, Date.now());
  assert.equal(isDaemonStarting(stateDir), false);

  const lock = await acquireDaemonLock({ stateDir });
  assert.ok(lock);
  assert.equal(holdsDaemonLock(lock), true);
  releaseDaemonLock(lock);
});

test("reclaims a live owner past its startup grace only when nothing serves", async () => {
  const stateDir = createTempDir();
  const longAgo = Date.now() - 10 * 60_000;
  writeDaemonLock(stateDir, process.pid, longAgo);

  assert.equal(
    await acquireDaemonLock({ stateDir, isServing: async () => true }),
    undefined,
  );

  const lock = await acquireDaemonLock({ stateDir, isServing: async () => false });
  assert.ok(lock);
  releaseDaemonLock(lock);
});

test("a daemon notices when its lock was taken over", async () => {
  const stateDir = createTempDir();
  const original = await acquireDaemonLock({ stateDir });
  assert.ok(original);
  writeDaemonLock(stateDir, DEAD_PID, Date.now());
  const takeover = await acquireDaemonLock({ stateDir });
  assert.ok(takeover);

  assert.equal(holdsDaemonLock(original), false);
  // Releasing the stale handle must not remove the new owner's lock.
  releaseDaemonLock(original);
  assert.equal(holdsDaemonLock(takeover), true);
  releaseDaemonLock(takeover);
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

test("describes the daemon lock holder for doctor output", async () => {
  const stateDir = createTempDir();
  assert.equal(daemonLockStatus(stateDir), null);
  assert.match(formatDaemonLockStatus(null), /not held/);

  const lock = await acquireDaemonLock({ stateDir });
  assert.ok(lock);
  const held = daemonLockStatus(stateDir);
  assert.equal(held?.pid, process.pid);
  assert.equal(held?.alive, true);
  assert.match(formatDaemonLockStatus(held), new RegExp(`held by pid ${process.pid} since`));
  releaseDaemonLock(lock);

  writeDaemonLock(stateDir, DEAD_PID, Date.now());
  assert.match(formatDaemonLockStatus(daemonLockStatus(stateDir)), /process gone/);
});

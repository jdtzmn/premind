import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  acquireDaemonLock,
  acquireDaemonStartLock,
  compareDaemonBuilds,
  daemonLockStatus,
  formatDaemonLockStatus,
  handOverOlderDaemon,
  holdsDaemonLock,
  identifySignalableDaemon,
  inspectDaemon,
  isRunningDaemonOlder,
  isSocketReachable,
  isDaemonStarting,
  probeDaemon,
  releaseDaemonLock,
  releaseDaemonStartLock,
  REQUEST_HANDOVER_OPERATION,
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

const build = (version: string, buildTime = 0) => ({ version, buildTime });

test("orders daemon builds by version, then commit time", () => {
  assert.equal(compareDaemonBuilds(build("0.2.0"), build("0.1.9")), "newer");
  assert.equal(compareDaemonBuilds(build("0.1.0", 9), build("0.2.0", 1)), "older");
  assert.equal(compareDaemonBuilds(build("0.1.0", 20), build("0.1.0", 10)), "newer");
  assert.equal(compareDaemonBuilds(build("0.1.0", 10), build("0.1.0", 10)), "same");
  // Equal versions with an unknown commit time never order: the running daemon wins.
  assert.equal(compareDaemonBuilds(build("0.1.0", 20), build("0.1.0")), "unordered");
  // An unknown candidate never takes over; an unknown running build always yields.
  assert.equal(compareDaemonBuilds(build("0.0.0", 20), build("0.1.0", 10)), "unordered");
  assert.equal(compareDaemonBuilds(build("dev"), build("0.1.0", 10)), "unordered");
  assert.equal(compareDaemonBuilds(build("0.1.0", 10), build("0.0.0")), "newer");
});

type FakeDaemon = {
  socketPath: string;
  requests: Array<{ type?: string; payload?: unknown }>;
  stop: () => Promise<void>;
};

/** A daemon that answers bootstrap and requestHandover like the real server. */
const startFakeDaemon = async ({
  version,
  buildTime,
  operations = [REQUEST_HANDOVER_OPERATION],
  acceptHandover = true,
  exitOnHandover = true,
}: {
  version: string;
  buildTime: number;
  operations?: string[];
  acceptHandover?: boolean;
  exitOnHandover?: boolean;
}): Promise<FakeDaemon> => {
  const socketPath = path.join(createTempDir(), "premind.sock");
  const requests: FakeDaemon["requests"] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { type?: string; payload?: unknown };
      requests.push(request);
      if (request.type === "initialize") {
        socket.end(
          `${JSON.stringify({
            ok: true,
            bootstrapVersion: 1,
            result: {
              daemon: { instanceId: "fake", pid: 1, version, commit: "abc123", buildTime, socketPath, lifecycleState: "ready" },
              protocols: { min: 1, max: 2, selected: 2 },
              capabilities: { operations, rollingSessions: false },
              storage: { epoch: 1, capabilities: [] },
            },
          })}\n`,
        );
        return;
      }
      socket.end(
        `${JSON.stringify({ ok: true, protocolVersion: 2, result: { accepted: acceptHandover } })}\n`,
      );
      if (acceptHandover && exitOnHandover) {
        setImmediate(() => {
          server.close();
          for (const open of sockets) open.destroy();
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const open of sockets) open.destroy();
        server.close(() => resolve());
        if (!server.listening) resolve();
      }),
  };
};

test("hands over only to a strictly newer build and waits for the old daemon to exit", async () => {
  const daemon = await startFakeDaemon({ version: "0.1.0", buildTime: 100 });
  const stateDir = createTempDir();
  try {
    assert.equal(
      await handOverOlderDaemon({
        build: build("0.1.0", 100),
        host: "pi",
        socketPath: daemon.socketPath,
        stateDir,
      }),
      "not-older",
    );
    assert.equal(
      await isRunningDaemonOlder({ build: build("0.1.0", 200), host: "pi", socketPath: daemon.socketPath }),
      true,
    );
    assert.equal(
      await handOverOlderDaemon({
        build: build("0.1.0", 200),
        host: "pi",
        socketPath: daemon.socketPath,
        stateDir,
        timeoutMs: 2_000,
      }),
      "handed-over",
    );
    assert.deepEqual(daemon.requests.at(-1), {
      type: REQUEST_HANDOVER_OPERATION,
      protocolVersion: 2,
      payload: { version: "0.1.0", buildTime: 200 },
    });
  } finally {
    await daemon.stop();
  }
});

test("never kills a daemon that refuses, lacks handover, or does not exit", async () => {
  const stateDir = createTempDir();
  const newer = build("9.0.0", 1);
  const cases: Array<{
    options: { acceptHandover?: boolean; operations?: string[]; exitOnHandover?: boolean };
    expected: string;
  }> = [
    { options: { acceptHandover: false }, expected: "refused" },
    { options: { operations: [] }, expected: "unsupported" },
    { options: { exitOnHandover: false }, expected: "timeout" },
  ];
  for (const { options, expected } of cases) {
    const daemon = await startFakeDaemon({ version: "0.1.0", buildTime: 1, ...options });
    try {
      assert.equal(
        await handOverOlderDaemon({
          build: newer,
          host: "pi",
          socketPath: daemon.socketPath,
          stateDir,
          timeoutMs: 200,
        }),
        expected,
      );
      assert.equal(await isSocketReachable(daemon.socketPath), true, expected);
    } finally {
      await daemon.stop();
    }
  }
});

test("treats a daemon without bootstrap as unsupported", async () => {
  const socketPath = path.join(createTempDir(), "premind.sock");
  const server = net.createServer((socket) =>
    socket.once("data", () =>
      socket.end(
        `${JSON.stringify({ ok: false, protocolVersion: 1, error: { code: "BAD_REQUEST", message: "unsupported request type" } })}\n`,
      ),
    ),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    assert.equal(
      await handOverOlderDaemon({ build: build("9.0.0", 1), host: "pi", socketPath, stateDir: createTempDir() }),
      "unsupported",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Spawns a stand-in for a Premind daemon that predates bootstrap: it holds the
 * daemon lock, answers status probes over protocol v1, rejects `initialize`,
 * and shuts down gracefully on SIGTERM like the real pre-handover daemons.
 */
const startLegacyDaemonProcess = async (entryName: string) => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  const entry = path.join(dir, entryName);
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
import net from "node:net";
const [socketPath, lockPath] = process.argv.slice(2);
fs.writeFileSync(lockPath, \`\${process.pid}:\${Date.now()}:legacy-token\`);
const server = net.createServer((socket) => socket.once("data", (chunk) => {
  const request = JSON.parse(String(chunk));
  socket.end(JSON.stringify(request.type === "initialize"
    ? { ok: false, protocolVersion: 1, error: { code: "BAD_REQUEST", message: "unsupported" } }
    : { ok: true, protocolVersion: 1, result: { daemon: { protocolVersion: 1, operations: [] } } }) + "\\n");
}));
server.listen(socketPath, () => process.stdout.write("ready\\n"));
process.on("SIGTERM", () => server.close(() => { fs.rmSync(lockPath, { force: true }); process.exit(0); }));
`,
  );
  const child = spawn(process.execPath, [entry, socketPath, path.join(stateDir, "daemon.lock")], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    socketPath,
    stateDir,
    pid: child.pid!,
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
};

test("stops an identified pre-handover daemon with SIGTERM so a newer build can start", async () => {
  const legacy = await startLegacyDaemonProcess("premind-daemon.mjs");
  try {
    const options = { host: "pi", socketPath: legacy.socketPath, stateDir: legacy.stateDir };
    assert.equal(await identifySignalableDaemon(options), legacy.pid);
    // A launcher of unknown build never replaces anything.
    assert.equal(await isRunningDaemonOlder({ ...options, build: build("0.0.0") }), false);
    assert.equal(
      await handOverOlderDaemon({ ...options, build: build("0.0.0"), timeoutMs: 200 }),
      "not-older",
    );
    assert.equal(await isRunningDaemonOlder({ ...options, build: build("0.1.0", 1) }), true);
    assert.equal(
      await handOverOlderDaemon({ ...options, build: build("0.1.0", 1), timeoutMs: 5_000 }),
      "handed-over",
    );
    await legacy.exited;
    assert.equal(fs.existsSync(path.join(legacy.stateDir, "daemon.lock")), false);
  } finally {
    await legacy.stop();
  }
});

test("never signals a process that is not an identified Premind daemon", async () => {
  // Same behavior and lock, but the command line is not a Premind entry point.
  const impostor = await startLegacyDaemonProcess("other-service.mjs");
  try {
    const options = {
      host: "pi",
      socketPath: impostor.socketPath,
      stateDir: impostor.stateDir,
      build: build("0.1.0", 1),
      timeoutMs: 200,
    };
    assert.equal(await identifySignalableDaemon(options), undefined);
    assert.equal(await handOverOlderDaemon(options), "unsupported");
    // A Premind command line whose lock belongs to another state directory is also left alone.
    assert.equal(
      await handOverOlderDaemon({
        ...options,
        stateDir: createTempDir(),
        readCommand: () => "node /opt/premind/premind-daemon.mjs",
      }),
      "unsupported",
    );
    assert.doesNotThrow(() => process.kill(impostor.pid, 0));
  } finally {
    await impostor.stop();
  }
});

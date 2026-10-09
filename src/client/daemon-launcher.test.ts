import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  inspectDaemon,
  readDaemonLockOwner,
} from "../shared/daemon-startup.ts";
import {
  createDaemonLauncher,
  type DaemonLaunchDiagnostic,
} from "./daemon-launcher.ts";
import { StateStore } from "../daemon/persistence/store.ts";
import { PremindDaemonClient } from "./daemon-client.ts";

const tempPaths: string[] = [];
const childPids: number[] = [];

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The daemon may have completed its idle shutdown already.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-launcher-"));
  tempPaths.push(dir);
  return dir;
};

test("refuses to replace an incompatible daemon on the global socket", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          ok: true,
          protocolVersion: 1,
          result: {
            daemon: {
              protocolVersion: 1,
              operations: ["registerClaudeSession"],
            },
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      createDaemonLauncher({
        socketPath,
        stateDir: dir,
        daemonEntry: path.join(dir, "must-not-start.mjs"),
        requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
      }),
      /incompatible Premind daemon.*will not be replaced automatically/i,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("leaves an unresponsive socket owner untouched", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      createDaemonLauncher({
        socketPath,
        stateDir: dir,
        daemonEntry: path.join(dir, "must-not-start.mjs"),
        requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
        startupTimeoutMs: 100,
        retryMs: 10,
      }),
      /did not answer the capability probe.*left untouched/i,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("captures early daemon stderr without retaining child pipes", async () => {
  const dir = createTempDir();
  const stateDir = path.join(dir, "state");
  const logPath = path.join(stateDir, "daemon.log");
  await assert.rejects(
    createDaemonLauncher({
      socketPath: path.join(dir, "premind.sock"),
      stateDir,
      daemonEntry: path.join(dir, "missing-daemon.mjs"),
      nodeExecutable: process.execPath,
      startupTimeoutMs: 1_000,
      retryMs: 10,
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes(`See ${logPath}`),
  );
  assert.match(fs.readFileSync(logPath, "utf8"), /Cannot find module/);
});

test("launches the dependency-closed daemon outside repository node_modules", async () => {
  const dir = createTempDir();
  const sourceBundle = path.resolve(
    "plugins",
    "premind",
    "generated",
    "premind-daemon.mjs",
  );
  const daemonEntry = path.join(dir, "premind-daemon.mjs");
  fs.copyFileSync(sourceBundle, daemonEntry);
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  const diagnostics: DaemonLaunchDiagnostic[] = [];

  await createDaemonLauncher({
    daemonEntry,
    socketPath,
    stateDir,
    nodeExecutable: process.execPath,
    cwd: dir,
    env: { NODE_PATH: "" },
    requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
    startupTimeoutMs: 5_000,
    retryMs: 25,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })();

  const started = diagnostics.find(
    (diagnostic) => diagnostic.phase === "daemon-started",
  );
  assert.ok(started?.spawnPid);
  childPids.push(started.spawnPid);
  assert.equal(fs.existsSync(socketPath), true);
  const bundle = fs.readFileSync(daemonEntry, "utf8");
  assert.equal(/from\s+["'](?:zod|xstate|tsx)["']/.test(bundle), false);
  assert.equal(bundle.includes(process.cwd()), false);
});

test("launcher caller exits promptly while the detached daemon remains reachable", async () => {
  const dir = createTempDir();
  const daemonEntry = path.join(dir, "premind-daemon.mjs");
  fs.copyFileSync(
    path.resolve("plugins", "premind", "generated", "premind-daemon.mjs"),
    daemonEntry,
  );
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  const driverPath = path.join(dir, "launch.mjs");
  const launcherUrl = new URL("./daemon-launcher.ts", import.meta.url).href;
  fs.writeFileSync(
    driverPath,
    `import { createDaemonLauncher } from ${JSON.stringify(launcherUrl)};
const diagnostics = [];
const options = ${JSON.stringify({
      daemonEntry,
      socketPath,
      stateDir,
      nodeExecutable: process.execPath,
      cwd: dir,
      env: { NODE_PATH: "" },
      requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
      startupTimeoutMs: 5_000,
      retryMs: 25,
    })};
options.onDiagnostic = (entry) => diagnostics.push(entry);
await createDaemonLauncher(options)();
process.stdout.write(JSON.stringify(diagnostics.find((entry) => entry.phase === "daemon-started")));
`,
  );

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ["--import", "tsx", driverPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 2_500,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - startedAt < 2_500, "launcher caller did not exit promptly");
  const diagnostic = JSON.parse(result.stdout) as DaemonLaunchDiagnostic;
  assert.ok(diagnostic.spawnPid);
  childPids.push(diagnostic.spawnPid);
  assert.equal(
    (await inspectDaemon(socketPath, CODEX_REQUIRED_DAEMON_OPERATIONS)).status,
    "compatible",
  );
});

test("concurrent daemon starts leave exactly one daemon running", async () => {
  const dir = createTempDir();
  const daemonEntry = path.join(dir, "premind-daemon.mjs");
  fs.copyFileSync(
    path.resolve("plugins", "premind", "generated", "premind-daemon.mjs"),
    daemonEntry,
  );
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  const env = {
    ...process.env,
    NODE_PATH: "",
    PREMIND_SOCKET_PATH: socketPath,
    PREMIND_STATE_DIR: stateDir,
  };

  // Several hosts noticing a missing daemon at once is how the start storm began.
  const children = Array.from({ length: 5 }, () =>
    spawn(process.execPath, [daemonEntry], { cwd: dir, env, stdio: "ignore" }),
  );
  const exited = new Set<number>();
  for (const child of children) {
    assert.ok(child.pid);
    childPids.push(child.pid);
    child.once("exit", () => exited.add(child.pid!));
  }

  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    (await inspectDaemon(socketPath)).status !== "compatible"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await inspectDaemon(socketPath)).status, "compatible");
  while (Date.now() < deadline && exited.size < children.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const running = children.filter((child) => !exited.has(child.pid!));
  assert.equal(running.length, 1);
  assert.equal(readDaemonLockOwner(stateDir)?.pid, running[0].pid);
});

test("hands over to a newer build while live sessions reconnect with their state", async () => {
  const dir = createTempDir();
  const daemonEntry = path.join(dir, "premind-daemon.mjs");
  fs.copyFileSync(
    path.resolve("plugins", "premind", "generated", "premind-daemon.mjs"),
    daemonEntry,
  );
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  const launcherFor = (build: { version: string; buildTime: number }) => {
    const diagnostics: DaemonLaunchDiagnostic[] = [];
    const launch = createDaemonLauncher({
      daemonEntry,
      socketPath,
      stateDir,
      nodeExecutable: process.execPath,
      cwd: dir,
      env: { NODE_PATH: "" },
      startupTimeoutMs: 10_000,
      retryMs: 25,
      build,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        if (diagnostic.phase === "daemon-started" && diagnostic.spawnPid) {
          childPids.push(diagnostic.spawnPid);
        }
      },
    });
    return { launch, diagnostics };
  };
  // The copied bundle cannot resolve its package, so the daemon reports an
  // unknown build. An unknown launcher never hands over; a known newer one does.
  const current = launcherFor({ version: "0.0.0", buildTime: 0 });
  const newer = launcherFor({ version: "99.0.0", buildTime: 1 });

  const clients = ["session-a", "session-b"].map((sessionId) => ({
    sessionId,
    client: new PremindDaemonClient({
      host: "pi",
      socketPath,
      ensureDaemon: current.launch,
      retryDelayMs: 10,
    }),
  }));
  for (const { sessionId, client } of clients) {
    await client.registerClient(dir, "test");
    await client.registerSession({
      sessionId,
      repo: "acme/repo",
      branch: `feature/${sessionId}`,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    });
  }
  const before = await clients[0]!.client.debugStatus();
  const oldPid = readDaemonLockOwner(stateDir)?.pid;
  assert.ok(oldPid);
  assert.equal(clients[0]!.client.selectedProtocolVersion, 2);

  // A reminder persisted before the handover must survive it.
  const store = new StateStore(path.join(stateDir, "epochs", "1", "premind.db"));
  const batchId = store.createOrReplaceReminder("session-a", null, "Review changed", [], 0);
  store.close();

  await newer.launch();
  const newPid = readDaemonLockOwner(stateDir)?.pid;
  assert.ok(newPid);
  assert.notEqual(newPid, oldPid);
  assert.ok(newer.diagnostics.some(({ phase }) => phase === "daemon-started"));
  assert.throws(() => process.kill(oldPid!, 0), "the old daemon exited");

  // Both clients reconnect on their next request and re-register their sessions.
  for (const { client } of clients) await client.heartbeat();
  const after = await clients[1]!.client.debugStatus();
  assert.equal(after.sessions.length, before.sessions.length);
  for (const sessionId of ["session-a", "session-b"]) {
    assert.equal(
      after.sessions.find((session) => session.sessionId === sessionId)?.status,
      "active",
      sessionId,
    );
  }
  const bundle = (await clients[0]!.client.claimReminderBundle("session-a")) as {
    bundle: { batches: Array<{ batchId: string }> } | null;
  };
  assert.deepEqual(
    bundle.bundle?.batches.map((batch) => batch.batchId),
    [batchId],
  );
  // The unknown launcher sees the newer daemon and leaves it alone.
  await current.launch();
  assert.equal(readDaemonLockOwner(stateDir)?.pid, newPid);
  for (const { client } of clients) await client.release();
});

test("a successor that fails to start leaves no stale lock and the next launch recovers", async () => {
  const dir = createTempDir();
  const socketPath = path.join(dir, "premind.sock");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  const legacy = spawn(
    process.execPath,
    [
      path.resolve("src/test/fixtures/legacy-daemon/premind-daemon.mjs"),
      socketPath,
      path.join(stateDir, "daemon.lock"),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve) => legacy.stdout!.once("data", resolve));
  const legacyExited = new Promise((resolve) => legacy.once("exit", resolve));
  const brokenEntry = path.join(dir, "broken-daemon.mjs");
  fs.writeFileSync(brokenEntry, "process.exit(1)\n");
  const launcher = (daemonEntry: string) =>
    createDaemonLauncher({
      daemonEntry,
      socketPath,
      stateDir,
      nodeExecutable: process.execPath,
      cwd: dir,
      env: { NODE_PATH: "" },
      startupTimeoutMs: 1_500,
      retryMs: 25,
      build: { version: "0.1.0", buildTime: 1 },
      onDiagnostic: (diagnostic) => {
        if (diagnostic.phase === "daemon-started" && diagnostic.spawnPid) {
          childPids.push(diagnostic.spawnPid);
        }
      },
    });

  // The old daemon hands over, then its successor exits immediately.
  await assert.rejects(launcher(brokenEntry)(), /failed to start/);
  await legacyExited;
  assert.equal(readDaemonLockOwner(stateDir), undefined, "no daemon lock left behind");
  assert.equal(fs.existsSync(path.join(stateDir, "daemon-start.lock")), false);

  // The next launch starts a working daemon.
  const bundle = path.join(dir, "premind-daemon.mjs");
  fs.copyFileSync(path.resolve("plugins/premind/generated/premind-daemon.mjs"), bundle);
  await launcher(bundle)();
  assert.equal(
    (await inspectDaemon(socketPath, CODEX_REQUIRED_DAEMON_OPERATIONS)).status,
    "compatible",
  );
});

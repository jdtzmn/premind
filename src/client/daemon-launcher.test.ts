import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  CODEX_REQUIRED_DAEMON_OPERATIONS,
  inspectDaemon,
} from "../shared/daemon-startup.ts";
import {
  createDaemonLauncher,
  type DaemonLaunchDiagnostic,
} from "./daemon-launcher.ts";

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
  const sourceBundle = path.resolve("runtime", "premind-daemon.mjs");
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
  fs.copyFileSync(path.resolve("runtime", "premind-daemon.mjs"), daemonEntry);
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

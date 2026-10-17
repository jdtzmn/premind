import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PREMIND_SOCKET_PATH, PREMIND_STATE_DIR } from "../../shared/constants.ts";
import { readDaemonLockOwner, readPackagedBuild } from "../../shared/daemon-startup.ts";
import { ensureDaemonRunning } from "../daemon-launcher.ts";

// The test scripts preload src/test/isolate-state-dir.mjs, so these constants
// point at a scratch state directory and socket for this process.
const legacyEntry = fileURLToPath(
  new URL("../../test/fixtures/legacy-daemon/premind-daemon.mjs", import.meta.url),
);

const daemonPid = () => readDaemonLockOwner(PREMIND_STATE_DIR)?.pid;
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitForExit = async (pid: number) => {
  for (let attempt = 0; attempt < 100 && isAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
};

after(async () => {
  const pid = daemonPid();
  if (pid && isAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForExit(pid);
  }
});

test("the Pi/OpenCode launcher replaces only older daemons", async () => {
  // A pre-handover daemon is stopped by SIGTERM and replaced.
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true });
  const legacy = spawn(
    process.execPath,
    [legacyEntry, PREMIND_SOCKET_PATH, path.join(PREMIND_STATE_DIR, "daemon.lock")],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve) => legacy.stdout!.once("data", resolve));
  await ensureDaemonRunning(undefined, { host: "pi" });
  assert.equal(await waitForExit(legacy.pid!), true, "the pre-handover daemon exited");
  const first = daemonPid();
  assert.ok(first);
  assert.notEqual(first, legacy.pid);

  // The same build attaches to the running daemon.
  await ensureDaemonRunning(undefined, { host: "pi" });
  assert.equal(daemonPid(), first);

  // A strictly newer build takes over through requestHandover.
  const own = readPackagedBuild();
  await ensureDaemonRunning(undefined, {
    host: "pi",
    build: { version: own.version, buildTime: own.buildTime + 60 },
  });
  assert.equal(await waitForExit(first!), true, "the older daemon handed over");
  const second = daemonPid();
  assert.ok(second);
  assert.notEqual(second, first);
});

test("concurrent launchers replace a pre-handover daemon exactly once", async () => {
  const running = daemonPid();
  if (running && isAlive(running)) {
    process.kill(running, "SIGTERM");
    assert.equal(await waitForExit(running), true);
  }
  const logPath = path.join(PREMIND_STATE_DIR, "daemon.log");
  const startsBefore = (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "")
    .split('"message":"listening"').length;
  const legacy = spawn(
    process.execPath,
    [legacyEntry, PREMIND_SOCKET_PATH, path.join(PREMIND_STATE_DIR, "daemon.lock")],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve) => legacy.stdout!.once("data", resolve));

  const results = await Promise.allSettled(
    ["pi", "opencode", "pi"].map((host) => ensureDaemonRunning(undefined, { host })),
  );
  assert.deepEqual(
    results.map(({ status }) => status),
    ["fulfilled", "fulfilled", "fulfilled"],
  );
  assert.equal(await waitForExit(legacy.pid!), true);
  const started =
    fs.readFileSync(logPath, "utf8").split('"message":"listening"').length - startsBefore;
  assert.equal(started, 1, "exactly one daemon started");
  const pid = daemonPid();
  assert.ok(pid && isAlive(pid));
});

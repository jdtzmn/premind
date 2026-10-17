import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { InstanceDescriptorV1 } from "./descriptor.ts";
import {
  instanceDescriptorDir,
  instanceRuntimeBaseDir,
  instanceSocketPath,
  listInstanceDescriptors,
  pruneUnreachableInstances,
  removeInstanceDescriptor,
  resolveInstanceRuntimeDir,
  writeInstanceDescriptor,
} from "./instance-registry.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const tempDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-instances-"));
  directories.push(directory);
  return directory;
};

const descriptor = (
  instanceId: string,
  socketPath: string,
): InstanceDescriptorV1 => ({
  descriptorFormat: 1,
  instanceId,
  pid: 1234,
  version: "0.2.0",
  commit: "abc123",
  socketPath,
  lifecycleState: "ready",
  protocols: { min: 1, max: 2 },
  storage: { epoch: 1, capabilities: ["legacy-singleton-v1"] },
  heartbeatAt: 1,
});

const A = "a1aa7407-10d2-4b1e-b58b-ac989b83d8b9";
const B = "b2bb7407-10d2-4b1e-b58b-ac989b83d8b9";

describe("instance registry", () => {
  test("creates an owner-only runtime directory with short socket paths", () => {
    const base = tempDir();
    const runtimeDir = resolveInstanceRuntimeDir(base);
    assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
    assert.equal(resolveInstanceRuntimeDir(base), runtimeDir);
    assert.equal(
      instanceSocketPath(runtimeDir, A),
      path.join(runtimeDir, "d-a1aa7407.sock"),
    );
  });

  test("falls back to /tmp when the preferred socket path would be too long", () => {
    assert.equal(instanceRuntimeBaseDir("/tmp/short"), "/tmp/short");
    const deep = `/tmp/${"nested-directory/".repeat(5)}`;
    assert.equal(instanceRuntimeBaseDir(deep), "/tmp");
  });

  test("tightens a loosened runtime directory and refuses a symlink", () => {
    const base = tempDir();
    const runtimeDir = resolveInstanceRuntimeDir(base);
    fs.chmodSync(runtimeDir, 0o755);
    resolveInstanceRuntimeDir(base);
    assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);

    const hijacked = tempDir();
    const elsewhere = tempDir();
    fs.symlinkSync(
      elsewhere,
      path.join(hijacked, `premind-${process.getuid?.() ?? "user"}`),
    );
    assert.throws(() => resolveInstanceRuntimeDir(hijacked), /INSECURE_RUNTIME_DIR/);
  });

  test("publishes, lists, and withdraws descriptors while skipping corrupt files", () => {
    const stateDir = tempDir();
    writeInstanceDescriptor(stateDir, descriptor(A, "/tmp/a.sock"));
    writeInstanceDescriptor(stateDir, { ...descriptor(A, "/tmp/a.sock"), heartbeatAt: 2 });
    fs.writeFileSync(path.join(instanceDescriptorDir(stateDir), "corrupt.json"), "{");
    const [listed, ...rest] = listInstanceDescriptors(stateDir);
    assert.equal(rest.length, 0);
    assert.equal(listed?.heartbeatAt, 2);
    assert.equal(
      fs.statSync(path.join(instanceDescriptorDir(stateDir), `${A}.json`)).mode & 0o777,
      0o600,
    );
    removeInstanceDescriptor(stateDir, A);
    assert.deepEqual(listInstanceDescriptors(stateDir), []);
    assert.deepEqual(listInstanceDescriptors(tempDir()), []);
  });

  test("prunes unreachable instances, deleting sockets only inside the runtime dir", async () => {
    const stateDir = tempDir();
    const runtimeDir = resolveInstanceRuntimeDir(tempDir());
    const outside = path.join(tempDir(), "outside.sock");
    fs.writeFileSync(outside, "");
    const stale = instanceSocketPath(runtimeDir, B);
    fs.writeFileSync(stale, "");
    writeInstanceDescriptor(stateDir, descriptor(A, outside));
    writeInstanceDescriptor(stateDir, descriptor(B, stale));
    const own = "c3cc7407-10d2-4b1e-b58b-ac989b83d8b9";
    writeInstanceDescriptor(stateDir, descriptor(own, "/tmp/own.sock"));

    const pruned = await pruneUnreachableInstances(
      stateDir,
      runtimeDir,
      async () => false,
      own,
    );
    assert.equal(pruned, 2);
    assert.deepEqual(
      listInstanceDescriptors(stateDir).map(({ instanceId }) => instanceId),
      [own],
    );
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(outside), true);
  });
});

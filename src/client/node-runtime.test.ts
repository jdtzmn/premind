import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  assertSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  resolveNodeRuntime,
} from "./node-runtime.ts";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

test("requires Node 22.13 or newer", () => {
  assert.throws(() => assertSupportedNodeVersion("v22.12.9"), /22\.13\.0/);
  assert.doesNotThrow(() => assertSupportedNodeVersion("v22.13.0"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("v23.0.0"));
  assert.throws(() => assertSupportedNodeVersion("not-node"), /Cannot parse/);
});

test("resolves and validates an explicit Node executable", () => {
  const runtime = resolveNodeRuntime({ executable: process.execPath });
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.version, process.version);
  assert.equal(MINIMUM_NODE_VERSION, "22.13.0");
});

test("reports missing and unsupported Node runtimes actionably", () => {
  assert.throws(
    () => resolveNodeRuntime({ environmentPath: "" }),
    /Node\.js 22\.13\.0 or newer is not available on PATH/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-node-runtime-"));
  tempPaths.push(dir);
  const executable = path.join(dir, "node");
  fs.writeFileSync(executable, "#!/bin/sh\necho v22.12.0\n", { mode: 0o755 });
  assert.throws(
    () => resolveNodeRuntime({ executable }),
    /stable node:sqlite support; found v22\.12\.0/,
  );
});

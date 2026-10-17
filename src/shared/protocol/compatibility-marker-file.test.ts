import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  readCompatibilityMarkerFile,
  updateCompatibilityMarkerFile,
  withCompatibilityMarkerLock,
} from "./compatibility-marker-file.ts";
import { parseCompatibilityMarker } from "./compatibility-marker.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createPaths = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-marker-test-"));
  directories.push(directory);
  return {
    directory,
    markerPath: path.join(directory, "compatibility-v1.json"),
    lockPath: path.join(directory, "compatibility-v1.lock"),
  };
};

const fixtureMarker = () =>
  parseCompatibilityMarker(
    fs.readFileSync(
      new URL("./__fixtures__/compatibility/v1/valid.json", import.meta.url),
    ),
  );

describe("compatibility marker file", () => {
  test("serializes writers through the frozen lock path", () => {
    const paths = createPaths();
    withCompatibilityMarkerLock(paths.lockPath, () => {
      assert.equal(fs.existsSync(paths.lockPath), true);
      assert.throws(
        () => withCompatibilityMarkerLock(paths.lockPath, () => undefined),
        (error: NodeJS.ErrnoException) => error.code === "EEXIST",
      );
    });
    assert.equal(fs.existsSync(paths.lockPath), false);
  });

  test("writes canonical bytes durably and never lowers ordered fields", () => {
    const paths = createPaths();
    const initial = updateCompatibilityMarkerFile(paths, fixtureMarker());
    assert.equal(initial.generation, 8);
    const updated = updateCompatibilityMarkerFile(paths, {
      ...initial,
      highestDaemonVersion: "0.2.5",
      minimumDaemonVersion: "0.1.0",
      serviceSupportFloor: "0.1.0",
      serviceSupportNotBefore: initial.serviceSupportNotBefore - 1,
      storageEpoch: 1,
      generation: 1,
    });
    assert.equal(updated.highestDaemonVersion, "0.3.0");
    assert.equal(updated.minimumDaemonVersion, "0.2.0");
    assert.equal(updated.serviceSupportFloor, "0.2.0");
    assert.equal(updated.serviceSupportNotBefore, initial.serviceSupportNotBefore);
    assert.equal(updated.storageEpoch, 1);
    assert.equal(updated.generation, 9);
    assert.deepEqual(readCompatibilityMarkerFile(paths.markerPath), updated);
    assert.deepEqual(
      fs.readdirSync(paths.directory).sort(),
      ["compatibility-v1.json"],
    );
  });

  test("removes the lock when a writer fails", () => {
    const paths = createPaths();
    assert.throws(() =>
      withCompatibilityMarkerLock(paths.lockPath, () => {
        throw new Error("crash point");
      }),
    );
    assert.equal(fs.existsSync(paths.lockPath), false);
  });
});

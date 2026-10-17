import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { readCompatibilityMarkerFile } from "./compatibility-marker-file.ts";
import { reconcileCompatibilityMarker } from "./compatibility-marker-reconciler.ts";
import {
  parseCompatibilityMarker,
  serializeCompatibilityMarker,
  type CompatibilityMarkerV1,
} from "./compatibility-marker.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createOptions = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-reconcile-test-"));
  directories.push(directory);
  return {
    directory,
    markerPath: path.join(directory, "compatibility-v1.json"),
    lockPath: path.join(directory, "compatibility-v1.lock"),
    dbPath: path.join(directory, "premind.db"),
    currentVersion: "0.3.0",
    now: 1_000,
  };
};

const candidate = (overrides: Partial<CompatibilityMarkerV1> = {}): CompatibilityMarkerV1 => ({
  markerFormat: 1,
  highestDaemonVersion: "0.3.0",
  minimumDaemonVersion: "0.2.0",
  serviceSupportFloor: "0.2.0",
  serviceSupportNotBefore: 10_000,
  storageEpoch: 1,
  generation: 0,
  ...overrides,
});

const readDatabaseMarker = (dbPath: string) => {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT marker_bytes FROM compatibility_marker_v1 WHERE singleton = 1`)
      .get() as { marker_bytes: Uint8Array };
    return parseCompatibilityMarker(row.marker_bytes);
  } finally {
    database.close();
  }
};

describe("compatibility marker reconciliation", () => {
  test("initializes identical filesystem and SQLite copies", () => {
    const options = createOptions();
    const marker = reconcileCompatibilityMarker({ ...options, candidate: candidate() });
    assert.equal(marker.generation, 1);
    assert.deepEqual(readCompatibilityMarkerFile(options.markerPath), marker);
    assert.deepEqual(readDatabaseMarker(options.dbPath), marker);
  });

  test("repairs a crash after filesystem publication monotonically", () => {
    const options = createOptions();
    assert.throws(() =>
      reconcileCompatibilityMarker({
        ...options,
        candidate: candidate(),
        afterFileWrite: () => {
          throw new Error("crash after rename");
        },
      }),
    );
    assert.equal(fs.existsSync(options.markerPath), true);
    assert.equal(fs.existsSync(options.dbPath), false);

    const repaired = reconcileCompatibilityMarker(options);
    assert.equal(repaired.generation, 2);
    assert.deepEqual(readCompatibilityMarkerFile(options.markerPath), repaired);
    assert.deepEqual(readDatabaseMarker(options.dbPath), repaired);
  });

  test("merges a newer SQLite copy upward into the file", () => {
    const options = createOptions();
    const initial = reconcileCompatibilityMarker({ ...options, candidate: candidate() });
    const database = new DatabaseSync(options.dbPath);
    try {
      database
        .prepare(`UPDATE compatibility_marker_v1 SET marker_bytes = ? WHERE singleton = 1`)
        .run(
          serializeCompatibilityMarker({
            ...initial,
            highestDaemonVersion: "0.4.0",
            storageEpoch: 2,
            generation: 5,
          }),
        );
    } finally {
      database.close();
    }

    const repaired = reconcileCompatibilityMarker({ ...options, currentVersion: "0.4.0" });
    assert.equal(repaired.highestDaemonVersion, "0.4.0");
    assert.equal(repaired.storageEpoch, 2);
    assert.equal(repaired.generation, 6);
    assert.deepEqual(readCompatibilityMarkerFile(options.markerPath), repaired);
  });

  test("repairs one corrupt copy but fails closed when both are corrupt", () => {
    const options = createOptions();
    reconcileCompatibilityMarker({ ...options, candidate: candidate() });
    fs.writeFileSync(options.markerPath, "not-json\n");
    const repaired = reconcileCompatibilityMarker(options);
    assert.equal(repaired.generation, 2);

    fs.writeFileSync(options.markerPath, "not-json\n");
    const database = new DatabaseSync(options.dbPath);
    try {
      database
        .prepare(`UPDATE compatibility_marker_v1 SET marker_bytes = ? WHERE singleton = 1`)
        .run(Buffer.from("also-not-json\n"));
    } finally {
      database.close();
    }
    assert.throws(
      () => reconcileCompatibilityMarker(options),
      /COMPATIBILITY_MARKER_CORRUPT/,
    );
  });

  test("checks service support before opening SQLite read-write", () => {
    const options = createOptions();
    assert.throws(
      () =>
        reconcileCompatibilityMarker({
          ...options,
          currentVersion: "0.3.0",
          now: 10_000,
          candidate: candidate({
            serviceSupportFloor: "0.4.0",
            serviceSupportNotBefore: 10_000,
          }),
        }),
      /SUPPORT_EXPIRED/,
    );
    assert.equal(fs.existsSync(options.markerPath), false);
    assert.equal(fs.existsSync(options.dbPath), false);
  });
});

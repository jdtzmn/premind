import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import {
  bridgeLegacyStorage,
  LEGACY_STORAGE_QUARANTINE_BYTES,
} from "./storage-bridge.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createOptions = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-bridge-test-"));
  directories.push(stateDir);
  const legacyDbPath = path.join(stateDir, "premind.db");
  const database = new DatabaseSync(legacyDbPath);
  database.exec(`CREATE TABLE retained_state (value TEXT NOT NULL)`);
  database.prepare(`INSERT INTO retained_state (value) VALUES (?)`).run("preserved");
  database.close();
  return {
    stateDir,
    legacyDbPath,
    modernDbPath: path.join(stateDir, "epochs", "1", "premind.db"),
    historicalSocketPath: path.join(stateDir, "premind.sock"),
    compatibilityLockPath: path.join(stateDir, "compatibility-v1.lock"),
  };
};

const readModernValue = (dbPath: string) => {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      database.prepare(`SELECT value FROM retained_state`).get() as { value: string }
    ).value;
  } finally {
    database.close();
  }
};

describe("legacy storage bridge", () => {
  test("backs up retained state and permanently quarantines the historical path", async () => {
    const options = createOptions();
    assert.equal(await bridgeLegacyStorage(options), "migrated");
    assert.equal(readModernValue(options.modernDbPath), "preserved");
    assert.deepEqual(fs.readFileSync(options.legacyDbPath), LEGACY_STORAGE_QUARANTINE_BYTES);
    assert.equal(fs.existsSync(`${options.legacyDbPath}.bridge-v1.sqlite`), true);
    assert.equal(await bridgeLegacyStorage(options), "already-bridged");

    const obsolete = new DatabaseSync(options.legacyDbPath, { readOnly: true });
    try {
      assert.throws(() => obsolete.prepare(`SELECT * FROM retained_state`).all());
    } finally {
      obsolete.close();
    }
  });

  test("recovers after modern publication but before quarantine", async () => {
    const options = createOptions();
    await assert.rejects(
      bridgeLegacyStorage({
        ...options,
        afterModernPublish: () => {
          throw new Error("crash before quarantine");
        },
      }),
    );
    assert.equal(readModernValue(options.modernDbPath), "preserved");
    assert.equal(readModernValue(options.legacyDbPath), "preserved");

    assert.equal(await bridgeLegacyStorage(options), "migrated");
    assert.deepEqual(fs.readFileSync(options.legacyDbPath), LEGACY_STORAGE_QUARANTINE_BYTES);
  });

  test("refuses cutover while a historical daemon socket is reachable", async () => {
    const options = createOptions();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.historicalSocketPath, resolve);
    });
    try {
      await assert.rejects(bridgeLegacyStorage(options), /LEGACY_DAEMON_ACTIVE/);
      assert.equal(readModernValue(options.legacyDbPath), "preserved");
      assert.equal(fs.existsSync(options.modernDbPath), false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

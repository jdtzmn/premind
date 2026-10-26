import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { sessionLeaseTokenSchema, type SessionLeaseToken } from "../../shared/schema.ts";
import { Router } from "../ipc/router.ts";
import { StateStore } from "./store.ts";

const fixture = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-session-epoch-"));
  const file = path.join(dir, "state.db");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
};
const claim = { sessionId: "s", ownerInstanceId: "daemon", clientIncarnationNonce: "A" };

const rejectsOldAuthority = (store: StateStore, db: DatabaseSync, token: SessionLeaseToken) => {
  const before = db.prepare("SELECT * FROM session_daemon_leases").get();
  assert.equal(store.validateSessionLease(token), false);
  assert.equal(store.renewSessionLease(token), false);
  assert.equal(store.releaseSessionLease(token), false);
  assert.throws(() => store.transferSessionLease(token, { ownerInstanceId: "B", clientIncarnationNonce: "B" }), /SESSION_MOVED/);
  assert.throws(() => store.releaseSessionOwner("s", Date.now(), token), /SESSION_MOVED/);
  assert.throws(() => store.releaseSessionOwner("s"), /SESSION_MOVED/);
  assert.deepEqual(db.prepare("SELECT * FROM session_daemon_leases").get(), before);
};

test("replacement epoch cannot validate, recover, renew, transfer or release an old session token", async (t) => {
  const { file, dir } = fixture(t);
  let store = new StateStore(file);
  const db = new DatabaseSync(file);
  db.function("premind_expected_storage_epoch", () => store.getStorageEpoch());
  t.after(() => { db.close(); store.close(); });
  store.registerClient("A", { pid: process.pid, projectRoot: dir });
  const token = store.claimSessionLease(claim);
  const payload = { sessionId: "s", clientId: "A", host: "pi" as const, hostSessionId: "native", status: "active" as const, busyState: "idle" as const, isPrimary: true, repo: "acme/repo", branch: "feature" };
  store.registerSession(payload);
  db.exec("DELETE FROM sessions; UPDATE storage_metadata SET storage_epoch = 2");
  assert.throws(() => store.registerSession(payload), /STORAGE_EPOCH_MOVED/);
  // Reopen at epoch 2: the connection fence alone no longer rejects writes.
  store.close();
  store = new StateStore(file);
  assert.equal(store.getStorageEpoch(), 2);
  rejectsOldAuthority(store, db, token);
  const response = await new Router(store).handle({ type: "registerSession", protocolVersion: 2, sessionLease: token, payload: { ...payload, recoverOnly: true } });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "SESSION_MOVED");
  assert.equal(store.getSession("s"), undefined);
  const next = store.claimSessionLease(claim);
  assert.equal(next.generation, token.generation + 1);
  assert.equal(db.prepare("SELECT storage_epoch FROM session_daemon_leases").get()?.storage_epoch, 2);
  assert.equal(store.validateSessionLease(next), true);
  assert.deepEqual(sessionLeaseTokenSchema.parse(next), next);
  assert.deepEqual(Object.keys(next).sort(), Object.keys(token).sort());
  assert.equal(store.validateSessionLease(token), false);
  const renewed = store.renewSessionLease(next);
  assert.ok(renewed);
  assert.equal(store.releaseSessionLease(renewed), true);
});

test("migration gives historical unknown-epoch leases epoch zero, never current authority", (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  const now = Date.now();
  const token: SessionLeaseToken = { ...claim, generation: 7, leaseToken: "00000000-0000-4000-8000-000000000001", claimedAt: now, expiresAt: now + 60_000 };
  db.exec(`CREATE TABLE session_daemon_leases (
    session_id TEXT PRIMARY KEY, owner_instance_id TEXT, generation INTEGER NOT NULL,
    client_incarnation_nonce TEXT, lease_token_hash TEXT, expires_at INTEGER
  )`);
  db.prepare("INSERT INTO session_daemon_leases VALUES (?, ?, ?, ?, ?, ?)").run(
    token.sessionId, token.ownerInstanceId, token.generation, token.clientIncarnationNonce,
    createHash("sha256").update(token.leaseToken).digest("hex"), token.expiresAt,
  );
  const store = new StateStore(file);
  t.after(() => { db.close(); store.close(); });
  assert.equal(db.prepare("SELECT storage_epoch FROM session_daemon_leases").get()?.storage_epoch, 0);
  rejectsOldAuthority(store, db, token);
  const next = store.claimSessionLease(claim);
  assert.equal(next.generation, 8);
  assert.equal(store.validateSessionLease(next), true);
  assert.equal(db.prepare("SELECT storage_epoch FROM session_daemon_leases").get()?.storage_epoch, 1);
});

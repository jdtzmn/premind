import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Router } from "../ipc/router.ts";
import { StateStore } from "./store.ts";

const fixture = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-session-prune-"));
  const file = path.join(dir, "state.db");
  let store = new StateStore(file);
  const db = new DatabaseSync(file);
  db.function("premind_expected_storage_epoch", () => store.getStorageEpoch());
  t.after(() => { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.registerClient("A", { pid: process.pid, projectRoot: dir });
  const claim = { sessionId: "s", ownerInstanceId: "daemon", clientIncarnationNonce: "A" };
  const lease = store.claimSessionLease(claim);
  const payload = { sessionId: "s", clientId: "A", host: "pi" as const, hostSessionId: "native", status: "active" as const, busyState: "idle" as const, isPrimary: true, repo: "acme/repo", branch: "feature" };
  store.registerSession(payload);
  return {
    store, db, lease, claim, payload,
    reopen: () => { store.close(); store = new StateStore(file); return store; },
  };
};

for (const method of ["pruneClosedSessions", "pruneClosedOrOrphanedSessions"] as const) {
  for (const origin of ["updateSessionState", "persisted-closed"] as const) {
    test(`${method} retains revocation for ${origin} rows across reopen`, async (t) => {
      const fixtureState = fixture(t);
      let { store } = fixtureState;
      const { db, lease, claim, payload } = fixtureState;
      if (origin === "updateSessionState") {
        const response = await new Router(store).handle({ type: "updateSessionState", protocolVersion: 2, sessionLease: lease, payload: { sessionId: "s", status: "closed" } });
        assert.equal(response.ok, true);
      } else {
        // Historical closed rows can still carry an owned lease.
        db.exec("UPDATE sessions SET status = 'closed'");
        store = fixtureState.reopen();
      }
      const recover = () => new Router(store).handle({ type: "registerSession", protocolVersion: 2, sessionLease: lease, payload: { ...payload, recoverOnly: true } });
      assert.equal((await recover()).ok, false);
      const now = Date.now() + 1000;
      const removed = method === "pruneClosedSessions" ? store.pruneClosedSessions(0, now) : store.pruneClosedOrOrphanedSessions(now, 0).sessions;
      assert.equal(removed, 1);
      assert.equal(store.getSession("s"), undefined);
      const tombstone = db.prepare("SELECT generation, owner_instance_id, lease_token_hash FROM session_daemon_leases WHERE session_id = 's'").get();
      assert.equal(tombstone?.generation, lease.generation);
      assert.equal(tombstone?.owner_instance_id, null);
      assert.equal(tombstone?.lease_token_hash, null);
      assert.equal(store.validateSessionLease(lease), false);
      assert.equal(store.renewSessionLease(lease), false);
      const rejected = await recover();
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, "SESSION_MOVED");
      store = fixtureState.reopen();
      assert.equal((await recover()).ok, false);
      const next = store.claimSessionLease(claim);
      assert.equal(next.generation, lease.generation + 1);
      assert.equal((await recover()).ok, false);
      assert.equal(store.validateSessionLease(next), true);
    });
  }

  test(`${method} rolls back revocation when row deletion fails`, (t) => {
    const { store, db, lease } = fixture(t);
    db.exec("UPDATE sessions SET status = 'closed'; CREATE TRIGGER fail_prune BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test prune failure'); END");
    const now = Date.now() + 1000;
    assert.throws(() => method === "pruneClosedSessions" ? store.pruneClosedSessions(0, now) : store.pruneClosedOrOrphanedSessions(now, 0), /test prune failure/);
    assert.equal(store.validateSessionLease(lease), true);
    assert.equal(store.getSession("s")?.status, "closed");
  });
}

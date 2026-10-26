import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { registerSessionPayloadSchema, type RegisterSessionPayload } from "../../shared/schema.ts";
import { StateStore, type SessionLeaseToken } from "../persistence/store.ts";
import { Router } from "./router.ts";

const setup = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-recovery-safety-"));
  const file = path.join(dir, "state.db");
  const store = new StateStore(file);
  const db = new DatabaseSync(file);
  db.function("premind_expected_storage_epoch", () => store.getStorageEpoch());
  t.after(() => { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const payload: RegisterSessionPayload = {
    clientId: "client", sessionId: "session", host: "pi", hostSessionId: "native",
    repo: "acme/repo", branch: "feature", isPrimary: true, status: "active", busyState: "idle",
  };
  store.registerClient(payload.clientId, { pid: process.pid, projectRoot: dir });
  const lease = store.claimSessionLease({ sessionId: payload.sessionId, ownerInstanceId: "daemon", clientIncarnationNonce: payload.clientId });
  store.registerSession(payload);
  const router = new Router(store);
  const recover = (token: SessionLeaseToken | undefined = lease, override: Partial<RegisterSessionPayload> = {}) =>
    router.handle({ type: "registerSession", protocolVersion: 1, sessionLease: token, payload: { ...payload, ...override, recoverOnly: true } });
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
  const loseRow = () => {
    // Model loss of only the legacy row, leaving separately durable state intact.
    db.exec("PRAGMA foreign_keys = OFF; DELETE FROM sessions; PRAGMA foreign_keys = ON;");
  };
  return { store, db, payload, lease, recover, router, rows, loseRow };
};

const moved = (response: Awaited<ReturnType<Router["handle"]>>) => {
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "SESSION_MOVED");
};

test("recoverOnly is opt-in and strict (including rejecting false and unknown fields)", () => {
  const payload = { clientId: "client", sessionId: "session", repo: "acme/repo", branch: "feature" };
  assert.equal(registerSessionPayloadSchema.parse(payload).recoverOnly, undefined);
  assert.equal(registerSessionPayloadSchema.parse({ ...payload, recoverOnly: true }).recoverOnly, true);
  assert.equal(registerSessionPayloadSchema.safeParse({ ...payload, recoverOnly: false }).success, false);
  assert.equal(registerSessionPayloadSchema.safeParse({ ...payload, unknown: true }).success, false);
  // The pre-recovery strict payload must reject the flag rather than ignore it.
  assert.equal(registerSessionPayloadSchema.omit({ recoverOnly: true }).safeParse({ ...payload, recoverOnly: true }).success, false);
});

test("valid repair preserves existing metadata, pause, subscriptions, binding, cursors and handoff", async (t) => {
  const { store, db, recover, rows, loseRow } = setup(t);
  store.setSessionPaused("session", true);
  store.upsertSubscription({ sessionId: "session", repo: "acme/repo", prNumber: 12, source: "manual" });
  store.upsertWorktreeBinding({ sessionId: "session", root: "/repo", gitDir: "/repo/.git", repo: "acme/repo", branch: "current", headSha: "abc", state: "waiting_for_pr" });
  db.exec(`UPDATE sessions SET branch = 'current', busy_state = 'busy', pr_number = 12, last_delivered_event_seq = 37;
    UPDATE session_subscriptions SET last_delivered_event_seq = 35;
    INSERT INTO reminder_batches (batch_id, session_id, reminder_text, events_json, state, max_event_seq, handoff_id, created_at, updated_at)
    VALUES ('batch', 'session', 'reminder', '[]', 'handed_off', 40, 'handoff', 1, 1);
    INSERT INTO reminder_handoff_execution_claims (handoff_id, session_id, owner_instance_id, session_generation, execution_generation, expires_at)
    VALUES ('handoff', 'session', 'daemon', 1, 1, 9999999999999);`);
  const tables = ["sessions", "session_pauses", "session_subscriptions", "worktree_bindings", "reminder_batches", "reminder_handoff_execution_claims", "session_daemon_leases"];
  const before = tables.map(rows);
  const response = await recover();
  assert.deepEqual(response, { ok: true, protocolVersion: 1, result: { registered: true, created: false } });
  assert.deepEqual(tables.map(rows), before);
  assert.equal(store.isSessionPaused("session"), true);
  assert.equal(store.claimReminderBundle("session"), null);
  loseRow();
  assert.equal((await recover()).ok, true);
  assert.deepEqual(tables.slice(1).map(rows), before.slice(1));
  assert.equal(store.claimReminderBundle("session"), null);
});

test("missing row repair retains separately durable state and starts legacy cursor at high-water", async (t) => {
  const { store, db, recover, rows, loseRow } = setup(t);
  store.setSessionPaused("session", true);
  store.upsertSubscription({ sessionId: "session", repo: "acme/repo", prNumber: 12, source: "manual" });
  db.exec(`INSERT INTO pr_events (repo, pr_number, dedupe_key, kind, priority, summary, payload_json, created_at)
    VALUES ('acme/repo', 12, 'event', 'review', 'high', 'history', '{}', 1);`);
  const tables = ["session_pauses", "session_subscriptions", "session_daemon_leases"];
  const before = tables.map(rows);
  loseRow();
  const response = await recover();
  assert.equal(response.ok, true);
  if (response.ok) assert.deepEqual(response.result, { registered: true, created: true });
  assert.equal(store.getSession("session")?.last_delivered_event_seq, 1);
  assert.deepEqual(tables.map(rows), before);
  assert.equal(store.claimReminderBundle("session"), null);
});

for (const host of ["pi", "claude", "opencode", "codex"] as const) {
  test(`shared recovery preserves active/paused authority for ${host}`, async (t) => {
    const { store, db, recover, loseRow, lease } = setup(t);
    db.prepare("UPDATE sessions SET host = ?, status = 'paused'").run(host);
    assert.equal((await recover(undefined, { host })).ok, true);
    assert.equal(store.getSession("session")?.status, "paused");
    loseRow();
    assert.equal((await recover(undefined, { host })).ok, true);
    assert.equal(store.getSession("session")?.host, host);
    store.releaseSessionOwner("session", Date.now(), lease);
    moved(await recover(undefined, { host }));
  });
}

for (const status of ["dormant", "detached", "closed"] as const) {
  test(`recovery refuses an existing ${status} row even with a valid lease`, async (t) => {
    const { db, recover } = setup(t);
    db.prepare("UPDATE sessions SET status = ?").run(status);
    moved(await recover());
    assert.equal(db.prepare("SELECT status FROM sessions").get()?.status, status);
  });
}

test("recovery requires a live client, matching client/host/native identity, and a lease even on v1", async (t) => {
  const { store, payload, recover, router, db, lease } = setup(t);
  moved(await router.handle({ type: "registerSession", protocolVersion: 1, payload: { ...payload, recoverOnly: true } }));
  moved(await recover(lease, { clientId: "other" }));
  moved(await recover(lease, { host: "opencode" }));
  moved(await recover(lease, { hostSessionId: "other" }));
  moved(await recover({ ...lease, sessionId: "other" }));
  moved(await recover({ ...lease, generation: lease.generation + 1 }));
  store.releaseClient(payload.clientId);
  moved(await recover());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 1);
});

for (const operation of ["releaseSessionOwner", "deleteSession"] as const) {
  for (const missing of [false, true]) {
    test(`${operation} permanently invalidates recovery with ${missing ? "missing" : "existing"} row`, async (t) => {
      const { store, lease, recover, rows, loseRow } = setup(t);
      if (missing) loseRow();
      assert.equal((operation === "releaseSessionOwner" ? store.releaseSessionOwner("session", Date.now(), lease) : store.deleteSession("session")), !missing);
      assert.equal(store.validateSessionLease(lease), false);
      moved(await recover());
      store.pruneClosedSessions(0, Date.now() + 1);
      moved(await recover());
      assert.equal(rows("session_daemon_leases").length, 1);
      // A fresh lifecycle can claim; the old recovery token can never reclaim.
      const next = store.claimSessionLease({ sessionId: "session", ownerInstanceId: "daemon", clientIncarnationNonce: "new-client" });
      assert.equal(next.generation, lease.generation + 1);
      moved(await recover());
    });
  }
  test(`${operation} rolls back both authority invalidation and lifecycle change`, (t) => {
    const { store, lease } = setup(t);
    assert.throws(() => store.transaction(() => { (operation === "releaseSessionOwner" ? store.releaseSessionOwner("session", Date.now(), lease) : store.deleteSession("session")); throw new Error("rollback"); }), /rollback/);
    assert.equal(store.validateSessionLease(lease), true);
    assert.equal(store.getSession("session")?.status, "active");
  });
}

test("delete invalidates a newly claimed lease even when already closed", async (t) => {
  const { store, recover } = setup(t);
  store.deleteSession("session");
  const lease = store.claimSessionLease({ sessionId: "session", ownerInstanceId: "daemon", clientIncarnationNonce: "client" });
  assert.equal(store.deleteSession("session"), false);
  assert.equal(store.validateSessionLease(lease), false);
  moved(await recover(lease));
});

test("expired, transferred and same-owner superseded tokens cannot repair a missing row", async (t) => {
  const { store, db, lease, recover, loseRow } = setup(t);
  loseRow();
  moved(await recover({ ...lease, leaseToken: "00000000-0000-4000-8000-000000000000" }));
  const renewedClaim = store.claimSessionLease({ sessionId: "session", ownerInstanceId: "daemon", clientIncarnationNonce: "client" });
  moved(await recover());
  assert.equal(store.validateSessionLease(renewedClaim), true);
  const transferred = store.transferSessionLease(renewedClaim, { ownerInstanceId: "new-daemon", clientIncarnationNonce: "new-client" });
  moved(await recover(renewedClaim));
  assert.equal(store.getSession("session"), undefined);
  assert.equal(store.validateSessionLease(transferred), true);
  db.exec("UPDATE session_daemon_leases SET expires_at = 0");
  moved(await recover(transferred));
});

test("recovery holds the authority write lock before entering registration", async (t) => {
  const { store, db, lease, recover, loseRow } = setup(t);
  loseRow();
  db.exec("PRAGMA busy_timeout = 0");
  const register = store.registerSession.bind(store);
  store.registerSession = (payload, now) => {
    assert.throws(
      () => db.exec("UPDATE session_daemon_leases SET expires_at = 0"),
      /database is locked/,
    );
    return register(payload, now);
  };
  assert.equal((await recover()).ok, true);
  assert.equal(store.validateSessionLease(lease), true);
  // The independent writer can invalidate only after the recovery commits.
  db.exec("UPDATE session_daemon_leases SET expires_at = 0");
  moved(await recover());
});

test("End between preliminary validation and recovery write is rechecked transactionally", async (t) => {
  const { store, recover, loseRow } = setup(t);
  loseRow();
  const validate = store.validateSessionLease.bind(store);
  let first = true;
  store.validateSessionLease = (lease, now) => {
    const valid = validate(lease, now);
    if (first) { first = false; store.releaseSessionOwner("session", Date.now(), lease); }
    return valid;
  };
  moved(await recover());
  assert.equal(store.getSession("session"), undefined);
});

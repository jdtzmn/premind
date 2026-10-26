import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { IpcServer } from "../daemon/ipc/server.ts";
import { StateStore } from "../daemon/persistence/store.ts";
import { registerSessionPayloadSchema, type RegisterSessionPayload } from "../shared/schema.ts";
import { PremindDaemonClient } from "./daemon-client.ts";

const setup = async (t: TestContext) => {
  const dir = fs.mkdtempSync("/tmp/premind-recover-client-");
  const socketPath = path.join(dir, "daemon.sock");
  const store = new StateStore(path.join(dir, "state.db"));
  const db = new DatabaseSync(path.join(dir, "state.db"));
  db.function("premind_expected_storage_epoch", () => store.getStorageEpoch());
  const server = new IpcServer(store);
  await server.listen(socketPath);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(socketPath); } };
  t.after(async () => { await close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let launches = 0;
  let claims = 0;
  const registrations: RegisterSessionPayload[] = [];
  const claim = store.claimSessionLease.bind(store);
  store.claimSessionLease = (...args) => { claims++; return claim(...args); };
  const register = store.registerSession.bind(store);
  let oldDaemon = false;
  store.registerSession = (payload, now) => {
    registrations.push(payload);
    if (oldDaemon) registerSessionPayloadSchema.omit({ recoverOnly: true }).parse(payload);
    return register(payload, now);
  };
  const client = new PremindDaemonClient({ host: "pi", socketPath, ensureDaemon: async () => { launches++; } });
  await client.registerClient(dir, "recovery-test");
  const registration = { sessionId: "session", host: "pi" as const, hostSessionId: "native", repo: "acme/repo", branch: "feature", isPrimary: true, status: "active" as const, busyState: "idle" as const };
  const leaseRow = () => db.prepare("SELECT * FROM session_daemon_leases WHERE session_id = 'session'").get();
  const counts = () => ({ claims, launches, registrations: registrations.length });
  return { store, db, client, close, registration, registrations, leaseRow, counts, rejectFlag: () => { oldDaemon = true; } };
};

test("recoverSession repairs through real v2 IPC under the existing lease and remembers ordinary registration", async (t) => {
  const { store, db, client, registration, registrations, leaseRow, counts } = await setup(t);
  await client.registerSession(registration);
  const before = counts();
  const lease = leaseRow();
  db.exec("DELETE FROM sessions");
  assert.deepEqual(await client.recoverSession("session"), { registered: true, created: true });
  assert.deepEqual(counts(), { ...before, registrations: before.registrations + 1 });
  assert.deepEqual(leaseRow(), lease);
  assert.deepEqual(registrations.at(-1), { ...registration, clientId: client.clientId, recoverOnly: true });
  assert.equal(store.getSession("session")?.host_session_id, "native");
  assert.deepEqual(await client.recoverSession("session"), { registered: true, created: false });
  assert.deepEqual(leaseRow(), lease);
  assert.equal(counts().claims, before.claims);
  // Recovery must not replace the remembered ordinary attachment with its flag.
  const attachments = (client as unknown as { attachedSessions: Map<string, { payload: RegisterSessionPayload }> }).attachedSessions;
  assert.equal(attachments.get("session")?.payload.recoverOnly, undefined);
});

test("recovery without a remembered registration or known lease fails without claiming", async (t) => {
  const { client, registration, counts } = await setup(t);
  const initial = counts();
  await assert.rejects(client.recoverSession("unknown"), /SESSION_MOVED/);
  assert.deepEqual(counts(), initial);
  await client.registerSession(registration);
  // ensureSessionControl remembers an attachment, but not a full registration.
  await client.ensureSessionControl({ sessionId: "control", repo: "acme/repo", branch: "feature", isPrimary: false, busyState: "idle", paused: false });
  const before = counts();
  await assert.rejects(client.recoverSession("control"), /SESSION_MOVED/);
  const leases = (client as unknown as { sessionLeases: Map<string, unknown> }).sessionLeases;
  leases.delete("session");
  await assert.rejects(client.recoverSession("session"), /SESSION_MOVED/);
  assert.deepEqual(counts(), before);
});

test("old strict daemon rejecting the recovery flag never gets a fallback registration or lease claim", async (t) => {
  const { client, registration, rejectFlag, counts, leaseRow } = await setup(t);
  await client.registerSession(registration);
  const before = counts();
  const lease = leaseRow();
  rejectFlag();
  await assert.rejects(client.recoverSession("session"), /BAD_REQUEST/);
  assert.deepEqual(counts(), { ...before, registrations: before.registrations + 1 });
  assert.deepEqual(leaseRow(), lease);
});

for (const operation of ["releaseSessionOwner", "deleteSession"] as const) {
  test(`late client recovery after ${operation} never claims or re-registers ordinarily`, async (t) => {
    const { store, client, registration, counts, leaseRow } = await setup(t);
    await client.registerSession(registration);
    if (operation === "releaseSessionOwner") await client.releaseSessionOwner("session");
    else store.deleteSession("session");
    const before = counts();
    const lease = leaseRow();
    await assert.rejects(client.recoverSession("session"), /SESSION_MOVED/);
    assert.deepEqual(counts(), before);
    assert.deepEqual(leaseRow(), lease);
  });
}

test("transport failure in recoverSession cannot start a daemon, reconnect, claim or replay", async (t) => {
  const { client, close, registration, counts } = await setup(t);
  await client.registerSession(registration);
  const before = counts();
  await close();
  await assert.rejects(client.recoverSession("session"), (error: unknown) => error instanceof Error && "domain" in error && error.domain === "transport");
  assert.deepEqual(counts(), before);
});


test("stale client End sends only its retained lease and never reclaims or replays", async (t) => {
  const { client, store, registration, counts, leaseRow } = await setup(t);
  await client.registerSession(registration);
  const leases = (client as unknown as { sessionLeases: Map<string, import("../shared/schema.ts").SessionLeaseToken> }).sessionLeases;
  const old = leases.get("session")!;
  const next = store.transferSessionLease(old, { ownerInstanceId: "replacement", clientIncarnationNonce: "B" });
  const before = counts();
  const row = leaseRow();
  await assert.rejects(client.releaseSessionOwner("session"), /SESSION_MOVED/);
  assert.deepEqual(counts(), before);
  assert.deepEqual(leaseRow(), row);
  assert.equal(store.validateSessionLease(next), true);
  assert.equal(store.getSession("session")?.status, "active");
});

test("End without a retained modern lease cannot claim cleanup authority", async (t) => {
  const { client, registration, counts, leaseRow } = await setup(t);
  await client.registerSession(registration);
  (client as unknown as { sessionLeases: Map<string, unknown> }).sessionLeases.clear();
  const before = counts();
  const row = leaseRow();
  await assert.rejects(client.releaseSessionOwner("session"), /SESSION_MOVED/);
  assert.deepEqual(counts(), before);
  assert.deepEqual(leaseRow(), row);
});

test("End transport failure never reconnects, claims or replays attachments", async (t) => {
  const { client, close, registration, counts } = await setup(t);
  await client.registerSession(registration);
  await close();
  const before = counts();
  await assert.rejects(client.releaseSessionOwner("session"), (error: unknown) => error instanceof Error && "domain" in error && error.domain === "transport");
  assert.deepEqual(counts(), before);
});

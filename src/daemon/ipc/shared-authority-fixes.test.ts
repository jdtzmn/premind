import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { RegisterSessionPayload, SessionLeaseToken } from "../../shared/schema.ts";
import { LegacyV1ProxyRouter } from "../../shared/protocol/legacy-v1-proxy.ts";
import { StateStore } from "../persistence/store.ts";
import { Router } from "./router.ts";

const setup = (t: TestContext, host: RegisterSessionPayload["host"] = "pi") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-authority-fixes-"));
  const file = path.join(dir, "state.db");
  const store = new StateStore(file);
  const db = new DatabaseSync(file);
  db.function("premind_expected_storage_epoch", () => store.getStorageEpoch());
  t.after(() => { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const payload: RegisterSessionPayload = {
    sessionId: "s", clientId: "A", host, hostSessionId: "native",
    repo: "acme/repo", branch: "feature", isPrimary: true, status: "active", busyState: "idle",
  };
  store.registerClient("A", { pid: process.pid, projectRoot: dir });
  const lease = store.claimSessionLease({ sessionId: "s", ownerInstanceId: "daemon", clientIncarnationNonce: "A" });
  store.registerSession(payload);
  const router = new Router(store);
  const recover = (target: Router, token: SessionLeaseToken = lease) => target.handle({
    type: "registerSession", protocolVersion: 2, sessionLease: token,
    payload: { ...payload, recoverOnly: true },
  });
  return { dir, file, store, db, payload, lease, router, recover };
};

const moved = (response: Awaited<ReturnType<Router["handle"]>>) => {
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "SESSION_MOVED");
};

for (const host of ["pi", "claude", "opencode", "codex"] as const) {
  test(`old End cannot revoke transferred ${host} owner, including legacy proxy cleanup`, async (t) => {
    const { store, db, payload, lease, router } = setup(t, host);
    const next = store.transferSessionLease(lease, { ownerInstanceId: "daemon", clientIncarnationNonce: "B" });
    store.registerSession({ ...payload, clientId: "B" });
    const before = db.prepare("SELECT * FROM session_daemon_leases").get();
    moved(await router.handle({ type: "releaseSessionOwner", protocolVersion: 2, payload: { sessionId: "s" } }));
    moved(await router.handle({ type: "releaseSessionOwner", protocolVersion: 2, sessionLease: lease, payload: { sessionId: "s" } }));
    moved(await router.handle({ type: "releaseSessionOwner", protocolVersion: 1, payload: { sessionId: "s" } }));
    store.saveLegacyProxyLease({ clientId: "B", proxyIncarnationNonce: next.clientIncarnationNonce, lease: next });
    const proxy = new LegacyV1ProxyRouter(store, "daemon", request => router.handle(request));
    const proxied = await proxy.handle({ type: "releaseSessionOwner", protocolVersion: 1, payload: { sessionId: "s" } });
    assert.equal(proxied.ok, false);
    assert.throws(() => store.releaseSessionOwner("s"), /SESSION_MOVED/);
    assert.deepEqual(db.prepare("SELECT * FROM session_daemon_leases").get(), before);
    assert.equal(store.validateSessionLease(next), true);
    assert.equal(store.getSession("s")?.client_id, "B");
    assert.equal(store.getSession("s")?.status, "active");
    assert.equal((await router.handle({ type: "releaseSessionOwner", protocolVersion: 2, sessionLease: next, payload: { sessionId: "s" } })).ok, true);
    assert.equal(store.validateSessionLease(next), false);
    assert.equal(store.getSession("s")?.status, "dormant");
  });

  test(`legacy ${host} cleanup works only without any owned lease`, async (t) => {
    const { store, db, router } = setup(t, host);
    db.exec("UPDATE session_daemon_leases SET expires_at = 0");
    moved(await router.handle({ type: "releaseSessionOwner", protocolVersion: 1, payload: { sessionId: "s" } }));
    db.exec("UPDATE session_daemon_leases SET owner_instance_id = NULL, client_incarnation_nonce = NULL, lease_token_hash = NULL, expires_at = NULL");
    const proxy = new LegacyV1ProxyRouter(store, "daemon", request => router.handle(request));
    assert.equal((await proxy.handle({ type: "releaseSessionOwner", protocolVersion: 1, payload: { sessionId: "s" } })).ok, true);
    assert.equal(store.getSession("s")?.status, "dormant");
  });
}

test("End revalidates under the authority write lock before changing session state", async (t) => {
  const { store, db, router, lease } = setup(t);
  const release = store.releaseSessionOwner.bind(store);
  store.releaseSessionOwner = (...args) => {
    db.exec("PRAGMA busy_timeout = 0");
    assert.throws(() => db.exec("UPDATE session_daemon_leases SET expires_at = 0"), /database is locked/);
    return release(...args);
  };
  assert.equal((await router.handle({ type: "releaseSessionOwner", protocolVersion: 2, sessionLease: lease, payload: { sessionId: "s" } })).ok, true);
});

test("ownership moved after preliminary End validation is rejected inside its transaction", async (t) => {
  const { store, router, lease } = setup(t);
  const validate = store.validateSessionLease.bind(store);
  let next: SessionLeaseToken | undefined;
  store.validateSessionLease = (token, now) => {
    const valid = validate(token, now);
    if (!next) next = store.transferSessionLease(token, { ownerInstanceId: "daemon", clientIncarnationNonce: "B" });
    return valid;
  };
  moved(await router.handle({ type: "releaseSessionOwner", protocolVersion: 2, sessionLease: lease, payload: { sessionId: "s" } }));
  assert.ok(next);
  assert.equal(validate(next), true);
  assert.equal(store.getSession("s")?.status, "active");
});

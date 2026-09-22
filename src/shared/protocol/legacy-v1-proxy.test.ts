import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  claimReminderBundleResponseSchema,
  legacyClaimReminderBundleResponseSchema,
} from "../ipc.ts";
import { Router } from "../../daemon/ipc/router.ts";
import { StateStore } from "../../daemon/persistence/store.ts";
import {
  LegacyV1ProxyRouter,
  projectV1ProxyResponse,
  SAFE_V1_PROXY_OPERATIONS,
} from "./legacy-v1-proxy.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createStore = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-v1-proxy-test-"));
  directories.push(directory);
  return new StateStore(path.join(directory, "premind.db"));
};

describe("safe protocol-v1 proxy", () => {
  test("freezes the allowlist and rejects coordinator maintenance", async () => {
    assert.equal(SAFE_V1_PROXY_OPERATIONS.has("pruneClosedSessions"), false);
    assert.equal(SAFE_V1_PROXY_OPERATIONS.has("deleteSession"), false);
    const store = createStore();
    const router = new Router(store);
    const proxy = new LegacyV1ProxyRouter(store, "daemon-a", (request) =>
      router.handle(request),
    );
    const response = await proxy.handle({
      type: "pruneClosedSessions",
      protocolVersion: 1,
      payload: {},
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "BAD_REQUEST");
    store.close();
  });

  test("projects bundle claims for both captured protocol-v1 decoders", () => {
    const projected = projectV1ProxyResponse("claimReminderBundle", {
      ok: true,
      protocolVersion: 2,
      result: { bundle: null },
    });
    assert.equal(projected.ok, true);
    if (!projected.ok) return;
    assert.deepEqual(claimReminderBundleResponseSchema.parse(projected.result), {
      bundle: null,
    });
    assert.deepEqual(legacyClaimReminderBundleResponseSchema.parse(projected.result), {
      batches: [],
    });
  });

  test("maps tokenless identities to rotating durable leases", async () => {
    const store = createStore();
    const router = new Router(store);
    const modernRequest = (request: Parameters<Router["handle"]>[0]) =>
      router.handle(request);
    const proxy = new LegacyV1ProxyRouter(store, "daemon-a", modernRequest);

    const registeredClient = await proxy.handle({
      type: "registerClient",
      protocolVersion: 1,
      payload: {
        clientId: "legacy-client",
        metadata: { pid: 1, projectRoot: "/repo" },
      },
    });
    assert.equal(registeredClient.ok, true, JSON.stringify(registeredClient));
    const registerRequest = {
      type: "registerSession",
      protocolVersion: 1,
      payload: {
        clientId: "legacy-client",
        sessionId: "legacy-session",
        repo: "acme/repo",
        branch: "feature/legacy",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
    } as const;
    assert.equal((await proxy.handle(registerRequest)).ok, true);
    const first = store.getLegacyProxyLease("legacy-session");
    assert.ok(first);
    assert.equal(first.lease.generation, 1);

    assert.equal(
      (
        await proxy.handle({
          type: "updateSessionState",
          protocolVersion: 1,
          payload: { sessionId: "legacy-session", busyState: "busy" },
        })
      ).ok,
      true,
    );
    assert.equal(store.getSession("legacy-session")?.busy_state, "busy");

    assert.equal((await proxy.handle(registerRequest)).ok, true);
    const second = store.getLegacyProxyLease("legacy-session");
    assert.ok(second);
    assert.equal(second.lease.generation, 2);
    assert.notEqual(second.proxyIncarnationNonce, first.proxyIncarnationNonce);
    const stale = await router.handle({
      type: "updateSessionState",
      protocolVersion: 2,
      sessionLease: first.lease,
      payload: { sessionId: "legacy-session", busyState: "idle" },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "SESSION_MOVED");

    const restartedProxy = new LegacyV1ProxyRouter(store, "daemon-a", modernRequest);
    const afterRestart = await restartedProxy.handle({
      type: "updateSessionState",
      protocolVersion: 1,
      payload: { sessionId: "legacy-session", busyState: "idle" },
    });
    assert.equal(afterRestart.ok, true);
    assert.equal(store.getSession("legacy-session")?.busy_state, "idle");

    const released = await restartedProxy.handle({
      type: "releaseClient",
      protocolVersion: 1,
      payload: { clientId: "legacy-client" },
    });
    assert.equal(released.ok, true);
    assert.equal(store.getLegacyProxyLease("legacy-session"), null);
    assert.equal(store.getSession("legacy-session")?.status, "detached");
    store.close();
  });

  test("denies ambient authority to an unmapped tokenless session", async () => {
    const store = createStore();
    const router = new Router(store);
    const proxy = new LegacyV1ProxyRouter(store, "daemon-a", (request) =>
      router.handle(request),
    );
    const response = await proxy.handle({
      type: "pauseSession",
      protocolVersion: 1,
      payload: { sessionId: "missing-session" },
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "SESSION_MOVED");
    store.close();
  });
});

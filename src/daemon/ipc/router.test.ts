import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { PREMIND_PROTOCOL_VERSION } from "../../shared/constants.ts";
import { requestSchema } from "../../shared/ipc.ts";
import { Router } from "./router.ts";
import { StateStore } from "../persistence/store.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";

const tempPaths: string[] = [];

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-router-test-"));
  tempPaths.push(dir);
  return new StateStore(path.join(dir, "premind.db"));
};

const worktree = {
  root: "/repo/.trees/feature",
  gitDir: "/repo/.git/worktrees/feature",
  repo: "acme/repo",
  branch: "feature/worktree",
  headSha: "abc123",
};

const registerSession = (store: StateStore, sessionId = "session-1") => {
  store.registerClient("client-1", { pid: 1, projectRoot: "/repo" });
  store.registerSession({
    clientId: "client-1",
    sessionId,
    repo: "acme/repo",
    branch: "feature/legacy",
    isPrimary: true,
    status: "active",
    busyState: "idle",
  });
};

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Router worktree subscription operations", () => {
  test("activates a worktree, replaces automatic subscriptions, and watches its branch", async () => {
    const store = createStore();
    registerSession(store);
    store.upsertSubscription({
      sessionId: "session-1",
      repo: "acme/repo",
      prNumber: 13,
      source: "automatic",
    });
    const requestedPaths: string[] = [];
    const worktreeBindings = new WorktreeBindingRegistry(store);
    const router = new Router(
      store,
      async (requestedPath) => {
        requestedPaths.push(requestedPath);
        return worktree;
      },
      worktreeBindings,
    );
    assert.equal(worktreeBindings.has("session-1"), false);

    const response = await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "session-1", path: "/repo/.trees/feature/src" },
    });

    assert.equal(response.ok, true);
    assert.deepEqual(requestedPaths, ["/repo/.trees/feature/src"]);
    assert.equal(worktreeBindings.has("session-1"), true);
    assert.equal(
      worktreeBindings.getSnapshot("session-1").value,
      "waiting_for_pr",
    );
    assert.deepEqual(store.getWorktreeBinding("session-1"), {
      sessionId: "session-1",
      ...worktree,
      state: "waiting_for_pr",
      updatedAt: store.getWorktreeBinding("session-1")?.updatedAt,
    });
    assert.equal(
      store.getSubscription("session-1", "acme/repo", 13)?.state,
      "unsubscribed",
    );
    assert.deepEqual(
      store
        .listBranchWatchTargets()
        .map((target) => [target.repo, target.branch]),
      [["acme/repo", "feature/worktree"]],
    );
    await router.handle({
      type: "unregisterSession",
      protocolVersion: 1,
      payload: { sessionId: "session-1" },
    });
    assert.equal(worktreeBindings.has("session-1"), false);
    store.close();
  });

  test("defaults subscriptions to the active repository and records automatic opt-outs", async () => {
    const store = createStore();
    registerSession(store);
    const worktreeBindings = new WorktreeBindingRegistry(store);
    const router = new Router(store, async () => worktree, worktreeBindings);
    await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "session-1", path: worktree.root },
    });

    const manualResponse = await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 42 },
    });
    assert.equal(manualResponse.ok, true);
    assert.equal(
      store.getSubscription("session-1", "acme/repo", 42)?.source,
      "manual",
    );

    await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", repo: "other/repo", prNumber: 99 },
    });
    assert.equal(
      store.getSubscription("session-1", "other/repo", 99)?.source,
      "manual",
    );

    store.upsertSubscription({
      sessionId: "session-1",
      repo: "acme/repo",
      prNumber: 13,
      source: "automatic",
    });
    const unsubscribeResponse = await router.handle({
      type: "unsubscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 13 },
    });

    assert.equal(unsubscribeResponse.ok, true);
    if (!unsubscribeResponse.ok) throw new Error("unsubscribe failed");
    assert.deepEqual(unsubscribeResponse.result, {
      unsubscribed: true,
      automaticOptOutRecorded: true,
    });
    assert.equal(
      worktreeBindings.getSnapshot("session-1").value,
      "automatic_pr_unsubscribed",
    );
    assert.equal(
      store.hasAutomaticSubscriptionOptOut({
        sessionId: "session-1",
        gitDir: worktree.gitDir,
        repo: worktree.repo,
        branch: worktree.branch,
        prNumber: 13,
      }),
      true,
    );
    assert.deepEqual(
      store
        .listPrWatchTargets()
        .map((target) => [target.repo, target.pr_number]),
      [
        ["acme/repo", 42],
        ["other/repo", 99],
      ],
    );
    store.close();
  });

  test("requires an existing session and an active worktree for default repositories", async () => {
    const store = createStore();
    const router = new Router(store, async () => worktree);

    const missingSession = await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "missing", path: worktree.root },
    });
    assert.deepEqual(missingSession, {
      ok: false,
      protocolVersion: 1,
      error: { code: "SESSION_NOT_FOUND", message: "Unknown session: missing" },
    });

    registerSession(store);
    const noBinding = await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 1 },
    });
    assert.deepEqual(noBinding, {
      ok: false,
      protocolVersion: 1,
      error: {
        code: "WORKTREE_NOT_ACTIVE",
        message: "An active worktree is required when repo is omitted",
      },
    });
    store.upsertSubscription({
      sessionId: "session-1",
      repo: "acme/repo",
      prNumber: 13,
      source: "automatic",
    });
    const legacyAutomatic = await router.handle({
      type: "unsubscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", repo: "acme/repo", prNumber: 13 },
    });
    assert.equal(legacyAutomatic.ok, true);
    if (!legacyAutomatic.ok) throw new Error("legacy unsubscribe failed");
    assert.deepEqual(legacyAutomatic.result, {
      unsubscribed: true,
      automaticOptOutRecorded: false,
    });
    store.close();
  });

  test("includes each session worktree binding and subscriptions in debug status", async () => {
    const store = createStore();
    registerSession(store);
    store.upsertWorktreeBinding(
      {
        sessionId: "session-1",
        ...worktree,
        state: "watching",
      },
      1,
    );
    store.upsertSubscription(
      {
        sessionId: "session-1",
        repo: "acme/repo",
        prNumber: 42,
        source: "automatic",
      },
      1,
    );
    store.upsertSubscription(
      {
        sessionId: "session-1",
        repo: "other/repo",
        prNumber: 99,
        source: "manual",
      },
      1,
    );
    store.unsubscribe("session-1", "other/repo", 99, 2);
    store.insertEvents(
      "acme/repo",
      42,
      [
        {
          dedupeKey: "issue_comment.created:42",
          kind: "issue_comment.created",
          priority: "high",
          summary: "New comment",
          payload: {},
        },
      ],
      3,
    );
    const router = new Router(store);
    const response = await router.handle({
      type: "debugStatus",
      protocolVersion: 1,
      payload: {},
    });
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("debugStatus failed");
    const result = response.result as {
      sessions: Array<{
        worktreeBinding: {
          root: string;
          repo: string;
          branch: string | null;
          state: string;
        } | null;
        subscriptions: Array<{
          repo: string;
          prNumber: number;
          source: string;
          state: string;
          pendingEventCount: number;
        }>;
      }>;
    };
    const session = result.sessions[0];
    assert.deepEqual(session.worktreeBinding, {
      root: worktree.root,
      gitDir: worktree.gitDir,
      repo: worktree.repo,
      branch: worktree.branch,
      headSha: worktree.headSha,
      state: "watching",
      updatedAt: 1,
    });
    assert.deepEqual(session.subscriptions, [
      {
        repo: "acme/repo",
        prNumber: 42,
        source: "automatic",
        state: "active",
        pendingEventCount: 1,
      },
      {
        repo: "other/repo",
        prNumber: 99,
        source: "manual",
        state: "unsubscribed",
        pendingEventCount: 0,
      },
    ]);
    store.close();
  });
});

const controlRequest = (clientId: string) => ({
  type: "ensureSessionControl" as const,
  protocolVersion: PREMIND_PROTOCOL_VERSION as 1,
  payload: {
    clientId,
    sessionId: "session-1",
    repo: "acme/repo",
    branch: "feature/x",
    isPrimary: true,
    busyState: "idle" as const,
    paused: false,
  },
});

describe("ensureSessionControl router", () => {
  test("rejects control from an unknown client without creating a session", async () => {
    const store = createStore();
    const response = await new Router(store).handle(
      controlRequest("missing-client"),
    );

    assert.deepEqual(response, {
      ok: false,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      error: {
        code: "CLIENT_NOT_FOUND",
        message: "Unknown client: missing-client",
      },
    });
    assert.equal(store.getSession("session-1"), undefined);
    store.close();
  });

  test("allows a registered client to attach and control its session", async () => {
    const store = createStore();
    store.registerClient("client-1", { pid: 123, projectRoot: "/tmp/project" });

    const response = await new Router(store).handle(controlRequest("client-1"));

    assert.deepEqual(response, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { attached: true, created: true, superseded: 0 },
    });
    assert.equal(store.getSession("session-1")?.client_id, "client-1");
    store.close();
  });
});

describe("Claude session IPC", () => {
  test("uses Claude session_id without a client lease and leaves Stop handoffs recoverable", async () => {
    const store = createStore();
    const router = new Router(store);
    const registered = await router.handle({
      type: "registerClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId: "claude-1",
        repo: "acme/repo",
        branch: "feature/claude",
        busyState: "idle",
      },
    });
    assert.equal(registered.ok, true);
    assert.equal(store.getSession("claude-1")?.client_id, "claude:claude-1");
    assert.equal(store.getSession("claude-1")?.host, "claude");
    assert.equal(store.getSession("claude-1")?.host_session_id, "claude-1");
    assert.equal(store.countActiveClients(), 0);
    const batchId = store.createOrReplaceReminder(
      "claude-1",
      null,
      "Review changed",
      [],
      0,
    );
    const claimed = await router.handle({
      type: "claimClaudeReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: "claude-1" },
    });
    assert.equal(claimed.ok, true);
    assert.equal(
      store.getReminderBatchRecord(batchId, "claude-1")?.state,
      "handed_off",
    );
    assert.notEqual(
      store.getReminderBatchRecord(batchId, "claude-1")?.state,
      "confirmed",
    );
    const touched = await router.handle({
      type: "touchClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: "claude-1", busyState: "busy" },
    });
    assert.equal(touched.ok, true);
    assert.equal(store.getSession("claude-1")?.busy_state, "busy");
    store.close();
  });

  test("suspends Claude sessions without deleting subscriptions or pending handoffs", async () => {
    const store = createStore();
    const router = new Router(store);
    const payload = {
      sessionId: "claude-resume",
      repo: "acme/repo",
      branch: "feature/claude",
      busyState: "idle" as const,
    };

    await router.handle({
      type: "registerClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    const subscription = store.upsertSubscription({
      sessionId: payload.sessionId,
      repo: payload.repo,
      prNumber: 42,
      source: "manual",
    });
    const batchId = store.createOrReplaceReminder(
      payload.sessionId,
      subscription.subscriptionId,
      "Review changed",
      [],
      0,
    );
    await router.handle({
      type: "claimClaudeReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: payload.sessionId },
    });

    const suspended = await router.handle({
      type: "suspendClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: payload.sessionId },
    });
    assert.deepEqual(suspended, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { suspended: true },
    });
    assert.equal(store.getSession(payload.sessionId)?.status, "closed");
    assert.equal(store.countActiveSessions(), 0);
    assert.equal(
      store.getSubscription(payload.sessionId, payload.repo, 42)?.state,
      "active",
    );
    assert.equal(
      store.getReminderBatchRecord(batchId, payload.sessionId)?.state,
      "handed_off",
    );

    await router.handle({
      type: "registerClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    assert.equal(store.getSession(payload.sessionId)?.status, "active");
    assert.equal(
      store.getSubscription(payload.sessionId, payload.repo, 42)?.state,
      "active",
    );
    assert.equal(
      store.getReminderBatchRecord(batchId, payload.sessionId)?.state,
      "handed_off",
    );
    store.close();
  });

  test("claims Claude handoffs atomically, retries stale handoffs, and confirms once", async () => {
    const store = createStore();
    const router = new Router(store);
    await router.handle({
      type: "registerClaudeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId: "claude-atomic",
        repo: "acme/repo",
        branch: "feature/claude",
        busyState: "idle",
      },
    });
    const batchId = store.createOrReplaceReminder(
      "claude-atomic",
      null,
      "Review changed",
      [],
      0,
    );
    const claims = await Promise.all([
      router.handle({
        type: "claimClaudeReminder",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId: "claude-atomic" },
      }),
      router.handle({
        type: "claimClaudeReminder",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId: "claude-atomic" },
      }),
    ]);
    const claimed = claims.filter(
      (response) =>
        response.ok && (response.result as { batch: unknown }).batch,
    );
    assert.equal(claimed.length, 1);
    assert.equal(
      store.getReminderBatchRecord(batchId, "claude-atomic")?.state,
      "handed_off",
    );

    // An interrupted handoff remains durable and becomes retryable rather than lost.
    store.expireStaleHandoffs(0, Date.now() + 1);
    const retried = await router.handle({
      type: "claimClaudeReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: "claude-atomic" },
    });
    assert.equal(retried.ok, true);
    assert.equal(
      store.getReminderBatchRecord(batchId, "claude-atomic")?.state,
      "handed_off",
    );

    const confirmed = await router.handle({
      type: "confirmClaudeHandoff",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: "claude-atomic" },
    });
    assert.deepEqual(confirmed, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { confirmed: true },
    });
    const doubleConfirm = await router.handle({
      type: "confirmClaudeHandoff",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId: "claude-atomic" },
    });
    assert.deepEqual(doubleConfirm, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { confirmed: false },
    });
    assert.equal(store.getReminderBatchRecord(batchId, "claude-atomic"), null);
    store.close();
  });
});

describe("generic reminder claim IPC", () => {
  test("accepts the documented atomic-claim wire format", () => {
    for (const boundary of [
      "session_start",
      "user_prompt_submit",
      "stop",
    ] as const) {
      assert.equal(
        requestSchema.safeParse({
          type: "claimReminder",
          protocolVersion: PREMIND_PROTOCOL_VERSION,
          payload: { sessionId: "codex:wire", boundary },
        }).success,
        true,
      );
    }
    assert.equal(
      requestSchema.safeParse({
        type: "settleReminderClaim",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: {
          sessionId: "codex:wire",
          batchId: "batch",
          handoffId: "00000000-0000-4000-8000-000000000000",
          outcome: "failed",
          failureReason: "hook exited before receipt persistence",
        },
      }).success,
      true,
    );
    assert.equal(
      requestSchema.safeParse({
        type: "claimReminder",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId: "codex:wire", boundary: "session-start" },
      }).success,
      false,
    );
  });

  test("migrates the pre-Codex host constraint without losing sessions", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "premind-codex-migrate-"),
    );
    tempPaths.push(dir);
    const dbPath = path.join(dir, "premind.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        host TEXT NOT NULL DEFAULT 'opencode' CHECK(host IN ('opencode', 'pi', 'claude')),
        host_session_id TEXT NOT NULL, client_id TEXT NOT NULL, repo TEXT NOT NULL,
        branch TEXT NOT NULL, pr_number INTEGER, is_primary INTEGER NOT NULL,
        status TEXT NOT NULL, busy_state TEXT NOT NULL,
        last_delivered_event_seq INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(host, host_session_id)
      );
      INSERT INTO sessions VALUES
        ('claude:legacy', 'claude', 'legacy', 'claude:legacy', 'acme/repo',
         'feature/legacy', NULL, 1, 'dormant', 'idle', 7, 1, 1, 1);
    `);
    legacy.close();

    const store = new StateStore(dbPath);
    assert.equal(
      store.getSession("claude:legacy")?.last_delivered_event_seq,
      7,
    );
    store.registerSession({
      sessionId: "codex:new",
      host: "codex",
      hostSessionId: "new",
      clientId: "codex:new",
      repo: "acme/repo",
      branch: "feature/codex",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    });
    assert.equal(store.getSession("codex:new")?.host, "codex");
    store.close();
  });

  test("leases one claim, rejects stale tokens, and preserves dormant session state", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "premind-codex-router-test-"),
    );
    tempPaths.push(dir);
    const dbPath = path.join(dir, "premind.db");
    let store = new StateStore(dbPath);
    let router = new Router(store);
    const competingStore = new StateStore(dbPath);
    const competingRouter = new Router(competingStore);
    const sessionId = "codex-atomic";
    const session = {
      sessionId,
      repo: "acme/repo",
      branch: "feature/codex",
      busyState: "idle" as const,
    };
    await router.handle({
      type: "registerCodexSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: session,
    });
    assert.equal(store.getSession(sessionId)?.host, "codex");
    const subscription = store.upsertSubscription({
      sessionId,
      repo: session.repo,
      prNumber: 42,
      source: "manual",
    });
    const batchId = store.createOrReplaceReminder(
      sessionId,
      subscription.subscriptionId,
      "Review changed",
      [],
      0,
      1,
    );
    const secondSubscription = store.upsertSubscription({
      sessionId,
      repo: session.repo,
      prNumber: 43,
      source: "manual",
    });
    const secondBatchId = store.createOrReplaceReminder(
      sessionId,
      secondSubscription.subscriptionId,
      "Review another change",
      [],
      0,
      2,
    );

    const claims = await Promise.all([
      router.handle({
        type: "claimReminder",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId, boundary: "stop" },
      }),
      competingRouter.handle({
        type: "claimReminder",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId, boundary: "stop" },
      }),
    ]);
    const claimResults = claims
      .filter((response) => response.ok)
      .map(
        (response) =>
          (
            response.result as {
              claim: {
                batch: { batchId: string };
                handoffId: string;
                leaseExpiresAt: number;
              } | null;
            }
          ).claim,
      )
      .filter((claim) => claim !== null);
    assert.equal(claimResults.length, 1);
    const firstClaim = claimResults[0];
    assert.ok(firstClaim);
    const claimedBatchId = firstClaim.batch.batchId;
    const unclaimedBatchId =
      claimedBatchId === batchId ? secondBatchId : batchId;
    assert.equal(
      store.getReminderBatchRecord(unclaimedBatchId, sessionId)?.state,
      "built",
    );

    const mismatched = await router.handle({
      type: "settleReminderClaim",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId,
        batchId: claimedBatchId,
        handoffId: "00000000-0000-4000-8000-000000000000",
        outcome: "confirmed",
      },
    });
    assert.deepEqual(mismatched, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { settled: false },
    });

    store.expireStaleHandoffs(undefined, firstClaim.leaseExpiresAt);
    const stale = await router.handle({
      type: "settleReminderClaim",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId,
        batchId: claimedBatchId,
        handoffId: firstClaim.handoffId,
        outcome: "confirmed",
      },
    });
    assert.equal(
      stale.ok && (stale.result as { settled: boolean }).settled,
      false,
    );

    const retried = await router.handle({
      type: "claimReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId, boundary: "user_prompt_submit" },
    });
    assert.equal(retried.ok, true);
    const secondClaim = (
      retried as {
        ok: true;
        result: { claim: { batch: { batchId: string }; handoffId: string } };
      }
    ).result.claim;
    assert.notEqual(secondClaim.handoffId, firstClaim.handoffId);
    assert.equal(secondClaim.batch.batchId, claimedBatchId);
    const delayedFirstSettlement = await competingRouter.handle({
      type: "settleReminderClaim",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId,
        batchId: claimedBatchId,
        handoffId: firstClaim.handoffId,
        outcome: "confirmed",
      },
    });
    assert.equal(
      delayedFirstSettlement.ok &&
        (delayedFirstSettlement.result as { settled: boolean }).settled,
      false,
    );

    const settled = await router.handle({
      type: "settleReminderClaim",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        sessionId,
        batchId: claimedBatchId,
        handoffId: secondClaim.handoffId,
        outcome: "confirmed",
      },
    });
    assert.equal(
      settled.ok && (settled.result as { settled: boolean }).settled,
      true,
    );
    assert.equal(store.getReminderBatchRecord(claimedBatchId, sessionId), null);
    assert.equal(
      store.getReminderBatchRecord(unclaimedBatchId, sessionId)?.state,
      "built",
    );
    assert.equal(store.hasDaemonDemand(), true);

    const released = await router.handle({
      type: "releaseSessionOwner",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
    assert.deepEqual(released, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { released: true },
    });
    assert.equal(store.getSession(sessionId)?.status, "dormant");
    assert.equal(store.countActiveSessions(), 0);
    assert.equal(store.hasDaemonDemand(), false);
    assert.equal(
      store.getSubscription(sessionId, session.repo, 42)?.state,
      "active",
    );
    const afterRetentionThresholds = Date.now() + 60 * 24 * 60 * 60 * 1000;
    assert.equal(
      store.reapStaleSessions(0, afterRetentionThresholds).reaped,
      0,
    );
    store.pruneClosedSessions(0, afterRetentionThresholds);
    assert.equal(store.pruneClosedOrOrphanedSessions().sessions, 0);
    assert.equal(store.getSession(sessionId)?.status, "dormant");
    assert.equal(
      store.getSubscription(sessionId, session.repo, 42)?.state,
      "active",
    );
    competingStore.close();
    store.close();
    store = new StateStore(dbPath);
    router = new Router(store);
    assert.equal(store.getSession(sessionId)?.status, "dormant");
    assert.equal(store.getSession(sessionId)?.host, "codex");
    assert.equal(
      store.getReminderBatchRecord(unclaimedBatchId, sessionId)?.state,
      "built",
    );

    const compactReconciliation = await router.handle({
      type: "registerCodexSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { ...session, reactivate: false },
    });
    assert.equal(compactReconciliation.ok, true);
    assert.equal(store.getSession(sessionId)?.status, "dormant");

    const resumed = await router.handle({
      type: "registerCodexSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: session,
    });
    assert.equal(resumed.ok, true);
    assert.equal(store.getSession(sessionId)?.status, "active");
    assert.equal(
      store.getSubscription(sessionId, session.repo, 42)?.state,
      "active",
    );

    const status = await router.handle({
      type: "debugStatus",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    });
    assert.equal(status.ok, true);
    const operations = (
      status as {
        ok: true;
        result: { daemon: { operations: string[] } };
      }
    ).result.daemon.operations;
    assert.ok(operations.includes("registerCodexSession"));
    assert.ok(operations.includes("claimReminder"));
    assert.ok(operations.includes("settleReminderClaim"));
    assert.ok(operations.includes("releaseSessionOwner"));
    store.close();
  });
});

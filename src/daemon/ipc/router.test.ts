import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { PREMIND_PROTOCOL_VERSION } from "../../shared/constants.ts"
import { Router } from "./router.ts"
import { StateStore } from "../persistence/store.ts"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-router-test-"))
  tempPaths.push(dir)
  return new StateStore(path.join(dir, "premind.db"))
}

const worktree = {
  root: "/repo/.trees/feature",
  gitDir: "/repo/.git/worktrees/feature",
  repo: "acme/repo",
  branch: "feature/worktree",
  headSha: "abc123",
}

const registerSession = (store: StateStore, sessionId = "session-1") => {
  store.registerClient("client-1", { pid: 1, projectRoot: "/repo" })
  store.registerSession({
    clientId: "client-1",
    sessionId,
    repo: "acme/repo",
    branch: "feature/legacy",
    isPrimary: true,
    status: "active",
    busyState: "idle",
  })
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("Router worktree subscription operations", () => {
  test("activates a worktree, replaces automatic subscriptions, and watches its branch", async () => {
    const store = createStore()
    registerSession(store)
    store.upsertSubscription({
      sessionId: "session-1",
      repo: "acme/repo",
      prNumber: 13,
      source: "automatic",
    })
    const requestedPaths: string[] = []
    const router = new Router(store, async (requestedPath) => {
      requestedPaths.push(requestedPath)
      return worktree
    })

    const response = await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "session-1", path: "/repo/.trees/feature/src" },
    })

    assert.equal(response.ok, true)
    assert.deepEqual(requestedPaths, ["/repo/.trees/feature/src"])
    assert.deepEqual(store.getWorktreeBinding("session-1"), {
      sessionId: "session-1",
      ...worktree,
      state: "waiting_for_pr",
      updatedAt: store.getWorktreeBinding("session-1")?.updatedAt,
    })
    assert.equal(
      store.getSubscription("session-1", "acme/repo", 13)?.state,
      "unsubscribed",
    )
    assert.deepEqual(
      store.listBranchWatchTargets().map((target) => [target.repo, target.branch]),
      [["acme/repo", "feature/worktree"]],
    )
    store.close()
  })

  test("defaults subscriptions to the active repository and records automatic opt-outs", async () => {
    const store = createStore()
    registerSession(store)
    const router = new Router(store, async () => worktree)
    await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "session-1", path: worktree.root },
    })

    const manualResponse = await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 42 },
    })
    assert.equal(manualResponse.ok, true)
    assert.equal(
      store.getSubscription("session-1", "acme/repo", 42)?.source,
      "manual",
    )

    await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", repo: "other/repo", prNumber: 99 },
    })
    assert.equal(
      store.getSubscription("session-1", "other/repo", 99)?.source,
      "manual",
    )

    store.upsertSubscription({
      sessionId: "session-1",
      repo: "acme/repo",
      prNumber: 13,
      source: "automatic",
    })
    const unsubscribeResponse = await router.handle({
      type: "unsubscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 13 },
    })

    assert.equal(unsubscribeResponse.ok, true)
    if (!unsubscribeResponse.ok) throw new Error("unsubscribe failed")
    assert.deepEqual(unsubscribeResponse.result, {
      unsubscribed: true,
      automaticOptOutRecorded: true,
    })
    assert.equal(
      store.hasAutomaticSubscriptionOptOut({
        sessionId: "session-1",
        gitDir: worktree.gitDir,
        repo: worktree.repo,
        branch: worktree.branch,
        prNumber: 13,
      }),
      true,
    )
    assert.deepEqual(
      store.listPrWatchTargets().map((target) => [target.repo, target.pr_number]),
      [
        ["acme/repo", 42],
        ["other/repo", 99],
      ],
    )
    store.close()
  })

  test("requires an existing session and an active worktree for default repositories", async () => {
    const store = createStore()
    const router = new Router(store, async () => worktree)

    const missingSession = await router.handle({
      type: "activateWorktree",
      protocolVersion: 1,
      payload: { sessionId: "missing", path: worktree.root },
    })
    assert.deepEqual(missingSession, {
      ok: false,
      protocolVersion: 1,
      error: { code: "SESSION_NOT_FOUND", message: "Unknown session: missing" },
    })

    registerSession(store)
    const noBinding = await router.handle({
      type: "subscribe",
      protocolVersion: 1,
      payload: { sessionId: "session-1", prNumber: 1 },
    })
    assert.deepEqual(noBinding, {
      ok: false,
      protocolVersion: 1,
      error: {
        code: "WORKTREE_NOT_ACTIVE",
        message: "An active worktree is required when repo is omitted",
      },
    })
    store.close()
  })

  test("includes each session worktree binding and subscriptions in debug status", async () => {
    const store = createStore()
    registerSession(store)
    store.upsertWorktreeBinding({
      sessionId: "session-1",
      ...worktree,
      state: "watching",
    }, 1)
    store.upsertSubscription({ sessionId: "session-1", repo: "acme/repo", prNumber: 42, source: "automatic" }, 1)
    store.upsertSubscription({ sessionId: "session-1", repo: "other/repo", prNumber: 99, source: "manual" }, 1)
    store.unsubscribe("session-1", "other/repo", 99, 2)
    store.insertEvents("acme/repo", 42, [{
      dedupeKey: "issue_comment.created:42",
      kind: "issue_comment.created",
      priority: "high",
      summary: "New comment",
      payload: {},
    }], 3)
    const router = new Router(store)
    const response = await router.handle({
      type: "debugStatus",
      protocolVersion: 1,
      payload: {},
    })
    assert.equal(response.ok, true)
    if (!response.ok) throw new Error("debugStatus failed")
    const result = response.result as { sessions: Array<{
      worktreeBinding: { root: string; repo: string; branch: string | null; state: string } | null
      subscriptions: Array<{ repo: string; prNumber: number; source: string; state: string; pendingEventCount: number }>
    }> }
    const session = result.sessions[0]
    assert.deepEqual(session.worktreeBinding, {
      root: worktree.root,
      gitDir: worktree.gitDir,
      repo: worktree.repo,
      branch: worktree.branch,
      headSha: worktree.headSha,
      state: "watching",
      updatedAt: 1,
    })
    assert.deepEqual(session.subscriptions, [
      { repo: "acme/repo", prNumber: 42, source: "automatic", state: "active", pendingEventCount: 1 },
      { repo: "other/repo", prNumber: 99, source: "manual", state: "unsubscribed", pendingEventCount: 0 },
    ])
    store.close()
  })

})

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
})

describe("ensureSessionControl router", () => {
  test("rejects control from an unknown client without creating a session", async () => {
    const store = createStore()
    const response = await new Router(store).handle(controlRequest("missing-client"))

    assert.deepEqual(response, {
      ok: false,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      error: {
        code: "CLIENT_NOT_FOUND",
        message: "Unknown client: missing-client",
      },
    })
    assert.equal(store.getSession("session-1"), undefined)
    store.close()
  })

  test("allows a registered client to attach and control its session", async () => {
    const store = createStore()
    store.registerClient("client-1", { pid: 123, projectRoot: "/tmp/project" })

    const response = await new Router(store).handle(controlRequest("client-1"))

    assert.deepEqual(response, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { attached: true, created: true, superseded: 0 },
    })
    assert.equal(store.getSession("session-1")?.client_id, "client-1")
    store.close()
  })
})

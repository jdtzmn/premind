import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createWorktreeBindingActor } from "./worktree-binding.ts"

const worktree = {
  root: "/repo/.trees/asdf",
  gitDir: "/repo/.git/worktrees/asdf",
  repo: "owner/repo",
  branch: "feature/asdf",
  headSha: "abc123",
}

describe("worktree binding machine", () => {
  test("waits for a PR after activating a named worktree", () => {
    const actor = createWorktreeBindingActor()
    actor.start()

    actor.send({ type: "ACTIVATE_WORKTREE", path: "/repo/.trees/asdf/src" })
    assert.equal(actor.getSnapshot().value, "resolving_worktree")

    actor.send({ type: "WORKTREE_RESOLVED", worktree })
    assert.equal(actor.getSnapshot().value, "waiting_for_pr")
    assert.deepEqual(actor.getSnapshot().context.worktree, worktree)

    actor.send({ type: "PR_NOT_FOUND" })
    assert.equal(actor.getSnapshot().value, "waiting_for_pr")
  })
  test("blocks automatic watching for a foreign PR until the PR becomes owned", () => {
    const actor = createWorktreeBindingActor()
    actor.start()
    actor.send({ type: "ACTIVATE_WORKTREE", path: worktree.root })
    actor.send({ type: "WORKTREE_RESOLVED", worktree })
    actor.send({ type: "PR_NOT_OWNED", pullRequest: { repo: "owner/repo", prNumber: 13 } })

    assert.equal(actor.getSnapshot().value, "foreign_pr")
    assert.deepEqual(actor.getSnapshot().context.automaticPullRequest, { repo: "owner/repo", prNumber: 13 })

    actor.send({ type: "PR_FOUND", pullRequest: { repo: "owner/repo", prNumber: 13 } })
    assert.equal(actor.getSnapshot().value, "following_automatic_pr")
  })


  test("follows a discovered PR and persists an automatic opt-out until another worktree activates", () => {
    const actor = createWorktreeBindingActor()
    actor.start()
    actor.send({ type: "ACTIVATE_WORKTREE", path: worktree.root })
    actor.send({ type: "WORKTREE_RESOLVED", worktree })
    actor.send({ type: "PR_FOUND", pullRequest: { repo: "owner/repo", prNumber: 13 } })

    assert.equal(actor.getSnapshot().value, "following_automatic_pr")
    actor.send({ type: "UNSUBSCRIBE_AUTOMATIC", pullRequest: { repo: "owner/repo", prNumber: 13 } })
    assert.equal(actor.getSnapshot().value, "automatic_pr_unsubscribed")

    actor.send({ type: "PR_FOUND", pullRequest: { repo: "owner/repo", prNumber: 13 } })
    assert.equal(actor.getSnapshot().value, "automatic_pr_unsubscribed")

    actor.send({ type: "ACTIVATE_WORKTREE", path: "/repo/.trees/next" })
    assert.equal(actor.getSnapshot().value, "resolving_worktree")
    assert.equal(actor.getSnapshot().context.automaticPullRequest, null)
  })

  test("does not attempt automatic branch tracking from detached HEAD", () => {
    const actor = createWorktreeBindingActor()
    actor.start()
    actor.send({ type: "ACTIVATE_WORKTREE", path: worktree.root })
    actor.send({ type: "WORKTREE_RESOLVED", worktree: { ...worktree, branch: null } })

    assert.equal(actor.getSnapshot().value, "detached_head")
    assert.equal(actor.getSnapshot().context.automaticPullRequest, null)
  })

  test("closes from any state", () => {
    const actor = createWorktreeBindingActor()
    actor.start()
    actor.send({ type: "ACTIVATE_WORKTREE", path: worktree.root })
    actor.send({ type: "SESSION_CLOSED" })

    assert.equal(actor.getSnapshot().value, "closed")
    assert.equal(actor.getSnapshot().context.worktree, null)
  })
})

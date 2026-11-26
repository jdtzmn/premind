import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { GitHubClient } from "../../daemon/github/client.ts"
import { diffSnapshot } from "../../daemon/github/diff.ts"
import { GITHUB_API_URL_ENV, GITHUB_TOKEN_ENV } from "../../daemon/github/http.ts"
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts"

let github: FakeGitHub
const saved = { url: process.env[GITHUB_API_URL_ENV], token: process.env[GITHUB_TOKEN_ENV] }

before(async () => {
  github = await startFakeGitHub()
  Object.assign(process.env, github.env())
})

after(async () => {
  for (const [name, value] of [
    [GITHUB_API_URL_ENV, saved.url],
    [GITHUB_TOKEN_ENV, saved.token],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await github.close()
})

test("the daemon's GitHub client reaches the fake through the test environment settings", async () => {
  // Constructed with no options, exactly as the daemon does.
  const client = new GitHubClient()
  github.addPullRequest({ repo: "acme/widgets", number: 7, headRefName: "feature/x", title: "Add widgets" })

  assert.equal(await client.getViewerLogin(), github.viewer)
  const found = await client.findOpenPullRequestForBranch("acme/widgets", "feature/x")
  assert.equal(found.kind, "ok")
  assert.equal(found.kind === "ok" ? found.pr?.number : undefined, 7)
  assert.equal(found.kind === "ok" ? found.pr?.authorLogin : undefined, github.viewer)
  assert.deepEqual(await client.findOpenPullRequestForBranch("acme/widgets", "other"), {
    kind: "ok",
    pr: null,
    etag: null,
  })
  assert.ok(github.requests.every((request) => request.authorization === `Bearer ${github.token}`))
})

test("changes made through the fake show up as PR events", async () => {
  const client = new GitHubClient()
  github.addPullRequest({ repo: "acme/widgets", number: 8, headRefName: "feature/y" })
  const first = await client.fetchPullRequestSnapshot("acme/widgets", 8)
  assert.equal(first.kind, "ok")

  github.addComment("acme/widgets", 8, { author: "alice", body: "Please rename this." })
  github.setCheck("acme/widgets", 8, { name: "test", status: "COMPLETED", conclusion: "FAILURE" })
  const second = await client.fetchPullRequestSnapshot("acme/widgets", 8)
  assert.equal(second.kind, "ok")
  if (first.kind !== "ok" || second.kind !== "ok") return

  const events = diffSnapshot(first.snapshot, second.snapshot)
  const kinds = events.map((event) => event.kind)
  assert.ok(kinds.some((kind) => kind.includes("comment")), `expected a comment event, got ${kinds.join(", ")}`)
  assert.ok(kinds.some((kind) => kind.includes("check") || kind.includes("ci")), `expected a check event, got ${kinds.join(", ")}`)
})

test("rejects requests without the fake token", async () => {
  const response = await fetch(`${github.url}/user`)
  assert.equal(response.status, 401)
})

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { GitHubHttpClient } from "./http.ts"
import { fetchPullRequestSnapshotGraphQL } from "./graphql.ts"

const makeFakeResponse = (init: { status: number; body?: string; headers?: Record<string, string> }) => {
  const headers = new Headers(init.headers)
  return new Response(init.body ?? null, { status: init.status, headers })
}

const tokenProvider = async () => "test-token"

const okGraphqlResponse = (data: unknown, etag?: string) =>
  makeFakeResponse({
    status: 200,
    body: JSON.stringify({ data }),
    headers: etag ? { etag } : {},
  })

type Fixture = {
  repository: {
    pullRequest: {
      number: number
      title: string
      url: string
      state: string
      isDraft: boolean
      headRefName: string
      baseRefName: string
      headRefOid: string
      mergeStateStatus: string
      reviewDecision: string
      updatedAt: string
      reviewRequests: {
        nodes: Array<{ requestedReviewer: { __typename: string; login?: string; slug?: string } }>
      }
      reviews: { nodes: unknown[] }
      comments: { nodes: unknown[] }
      reviewThreads: { nodes: unknown[] }
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup:
              | {
                  contexts: { nodes: Array<Record<string, unknown>> }
                }
              | null
          }
        }>
      }
    } | null
  }
}

const fullFixture = (): Fixture => ({
  repository: {
    pullRequest: {
      number: 42,
      title: "Feature",
      url: "https://github.com/acme/repo/pull/42",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/test",
      baseRefName: "main",
      headRefOid: "sha-1",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      updatedAt: "2026-04-08T00:00:00Z",
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "User", login: "alice" } },
          { requestedReviewer: { __typename: "Team", slug: "platform" } },
        ],
      },
      reviews: {
        nodes: [
          {
            databaseId: 1001,
            state: "APPROVED",
            body: "LGTM",
            submittedAt: "2026-04-08T01:00:00Z",
            authorAssociation: "MEMBER",
            author: { login: "alice" },
          },
        ],
      },
      comments: {
        nodes: [
          {
            databaseId: 2001,
            body: "nit: rename",
            createdAt: "2026-04-08T00:30:00Z",
            updatedAt: "2026-04-08T00:30:00Z",
            author: { login: "bob" },
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            comments: {
              nodes: [
                {
                  databaseId: 3001,
                  body: "consider null-check",
                  createdAt: "2026-04-08T00:45:00Z",
                  updatedAt: "2026-04-08T00:45:00Z",
                  path: "src/foo.ts",
                  line: 12,
                  originalLine: 12,
                  author: { login: "carol" },
                },
              ],
            },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "build",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: "https://ci.example/build/1",
                      checkSuite: { workflowRun: { event: "pull_request", workflow: { name: "CI" } } },
                    },
                    {
                      __typename: "CheckRun",
                      name: "test",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://ci.example/test/1",
                      checkSuite: { workflowRun: { event: "pull_request", workflow: { name: "CI" } } },
                    },
                    {
                      __typename: "StatusContext",
                      context: "netlify/deploy",
                      state: "SUCCESS",
                      targetUrl: "https://netlify.example",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  },
})

describe("fetchPullRequestSnapshotGraphQL", () => {
  test("maps full GraphQL response onto PullRequestSnapshot", async () => {
    const stub: typeof fetch = async () => okGraphqlResponse(fullFixture(), 'W/"v1"')
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    const now = 1_700_000_000_000
    const result = await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 42, { now: () => now })

    assert.equal(result.kind, "ok")
    if (result.kind !== "ok") throw new Error("unreachable")
    assert.equal(result.etag, 'W/"v1"')

    const snapshot = result.snapshot
    assert.equal(snapshot.core.number, 42)
    assert.equal(snapshot.core.reviewDecision, "APPROVED")
    assert.equal(snapshot.core.headRefOid, "sha-1")
    assert.deepEqual(
      snapshot.core.reviewRequests?.map((request) => request.login),
      ["alice", "team:platform"],
    )

    assert.equal(snapshot.reviews.length, 1)
    assert.equal(snapshot.reviews[0].id, 1001)
    assert.equal(snapshot.reviews[0].user?.login, "alice")

    assert.equal(snapshot.issueComments.length, 1)
    assert.equal(snapshot.issueComments[0].id, 2001)

    assert.equal(snapshot.reviewComments.length, 1)
    assert.equal(snapshot.reviewComments[0].id, 3001)
    assert.equal(snapshot.reviewComments[0].path, "src/foo.ts")
    assert.equal(snapshot.reviewComments[0].line, 12)

    assert.equal(snapshot.checks.length, 3)
    const byName = Object.fromEntries(snapshot.checks.map((check) => [check.name, check]))
    assert.equal(byName.build.state, "pass")
    assert.equal(byName.test.state, "fail")
    assert.equal(byName["netlify/deploy"].state, "pass")
    assert.equal(snapshot.fetchedAt, now)
  })

  test("returns kind: not_found when pullRequest is null (repo or PR missing)", async () => {
    const stub: typeof fetch = async () =>
      okGraphqlResponse({ repository: { pullRequest: null } })
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    const result = await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 9999)
    assert.equal(result.kind, "not_found")
  })

  test("forwards 304 from HTTP client as not_modified", async () => {
    const stub: typeof fetch = async () =>
      makeFakeResponse({ status: 304, headers: { etag: 'W/"v1"' } })
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    const result = await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 42, {
      previousEtag: 'W/"v1"',
    })
    assert.equal(result.kind, "not_modified")
    if (result.kind !== "not_modified") throw new Error("unreachable")
    assert.equal(result.etag, 'W/"v1"')
  })

  test("sends If-None-Match header when previousEtag provided", async () => {
    let observedEtag: string | null = null
    const stub: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      observedEtag = headers.get("if-none-match")
      return okGraphqlResponse(fullFixture(), 'W/"v2"')
    }
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 42, { previousEtag: 'W/"v1"' })
    assert.equal(observedEtag, 'W/"v1"')
  })

  test("tolerates empty checks/reviews/comments arrays", async () => {
    const emptyFixture = () => {
      const fixture = fullFixture()
      const pr = fixture.repository.pullRequest
      if (!pr) throw new Error("fixture missing pr")
      pr.reviews.nodes = []
      pr.comments.nodes = []
      pr.reviewThreads.nodes = []
      pr.commits.nodes[0].commit.statusCheckRollup = null
      return fixture
    }
    const stub: typeof fetch = async () => okGraphqlResponse(emptyFixture())
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    const result = await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 42)
    assert.equal(result.kind, "ok")
    if (result.kind !== "ok") throw new Error("unreachable")
    assert.equal(result.snapshot.reviews.length, 0)
    assert.equal(result.snapshot.issueComments.length, 0)
    assert.equal(result.snapshot.reviewComments.length, 0)
    assert.equal(result.snapshot.checks.length, 0)
  })

  test("maps CheckRun status variants (in_progress, queued, cancelled, skipped)", async () => {
    const fixture = fullFixture()
    const pr = fixture.repository.pullRequest
    if (!pr) throw new Error("fixture missing pr")
    pr.commits.nodes[0].commit.statusCheckRollup = {
      contexts: {
        nodes: [
          { __typename: "CheckRun", name: "a", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, checkSuite: null },
          { __typename: "CheckRun", name: "b", status: "QUEUED", conclusion: null, detailsUrl: null, checkSuite: null },
          { __typename: "CheckRun", name: "c", status: "COMPLETED", conclusion: "CANCELLED", detailsUrl: null, checkSuite: null },
          { __typename: "CheckRun", name: "d", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null, checkSuite: null },
        ],
      },
    }
    const stub: typeof fetch = async () => okGraphqlResponse(fixture)
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    const result = await fetchPullRequestSnapshotGraphQL(client, "acme/repo", 42)
    assert.equal(result.kind, "ok")
    if (result.kind !== "ok") throw new Error("unreachable")
    const byName = Object.fromEntries(result.snapshot.checks.map((check) => [check.name, check]))
    assert.equal(byName.a.state, "in_progress")
    assert.equal(byName.b.state, "pending")
    assert.equal(byName.c.state, "cancelled")
    assert.equal(byName.d.state, "skipping")
  })
})

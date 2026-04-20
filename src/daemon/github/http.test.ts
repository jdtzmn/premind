import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { GitHubHttpClient, GitHubHttpError } from "./http.ts"
import { RateLimitTracker } from "./ratelimit.ts"

type FakeResponseInit = {
  status: number
  body?: string
  headers?: Record<string, string>
}

const makeFakeResponse = (init: FakeResponseInit): Response => {
  const headers = new Headers(init.headers)
  return new Response(init.body ?? null, { status: init.status, headers })
}

type Call = { url: string; init: RequestInit | undefined }

const makeFetchStub = (responses: FakeResponseInit[]) => {
  const calls: Call[] = []
  let index = 0
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    calls.push({ url, init })
    const next = responses[index]
    if (!next) throw new Error(`fetch stub exhausted (${index})`)
    index++
    return makeFakeResponse(next)
  }
  return { stub, calls }
}

const authHeader = async () => "test-token"

describe("GitHubHttpClient.get", () => {
  test("sends Authorization/UA/Accept headers and returns parsed JSON", async () => {
    const { stub, calls } = makeFetchStub([
      { status: 200, body: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } },
    ])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    const result = await client.get<{ ok: boolean }>("repos/acme/repo/pulls")

    assert.equal(result.kind, "ok")
    if (result.kind !== "ok") throw new Error("unreachable")
    assert.deepEqual(result.data, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.github.com/repos/acme/repo/pulls")

    const headers = new Headers(calls[0].init?.headers as HeadersInit | undefined)
    assert.equal(headers.get("authorization"), "Bearer test-token")
    assert.equal(headers.get("user-agent"), "premind-daemon")
    assert.equal(headers.get("accept"), "application/vnd.github+json")
    assert.equal(headers.get("x-github-api-version"), "2022-11-28")
  })

  test("returns kind: not_modified on 304 and captures etag", async () => {
    const { stub } = makeFetchStub([{ status: 304, headers: { etag: 'W/"abc"' } }])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    const result = await client.get("repos/acme/repo/pulls", { etag: 'W/"abc"' })
    assert.equal(result.kind, "not_modified")
    if (result.kind !== "not_modified") throw new Error("unreachable")
    assert.equal(result.etag, 'W/"abc"')
  })

  test("sends If-None-Match when etag provided", async () => {
    const { stub, calls } = makeFetchStub([{ status: 304 }])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    await client.get("repos/acme/repo/pulls", { etag: 'W/"xyz"' })
    const headers = new Headers(calls[0].init?.headers as HeadersInit | undefined)
    assert.equal(headers.get("if-none-match"), 'W/"xyz"')
  })

  test("ingests X-RateLimit-* headers into the tracker", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600
    const { stub } = makeFetchStub([
      {
        status: 200,
        body: "{}",
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": String(resetSec),
          "x-ratelimit-resource": "core",
        },
      },
    ])
    const rateLimit = new RateLimitTracker()
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader, rateLimit })
    await client.get("repos/acme/repo/pulls")
    assert.equal(rateLimit.getSnapshot("core")?.remaining, 4998)
  })

  test("throws GitHubHttpError on 403 with Retry-After and records retry-after", async () => {
    const { stub } = makeFetchStub([
      {
        status: 403,
        body: "rate limited",
        headers: { "retry-after": "42", "x-ratelimit-resource": "core" },
      },
    ])
    const rateLimit = new RateLimitTracker()
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader, rateLimit })
    await assert.rejects(
      () => client.get("repos/acme/repo/pulls"),
      (error: unknown) => {
        assert.ok(error instanceof GitHubHttpError)
        assert.equal((error as GitHubHttpError).status, 403)
        assert.equal((error as GitHubHttpError).retryAfterSeconds, 42)
        return true
      },
    )
    assert.equal(rateLimit.isThrottled("core"), true)
  })

  test("on 401 the cached token is invalidated so next request fetches fresh", async () => {
    const { stub } = makeFetchStub([
      { status: 401, body: "bad creds" },
      { status: 200, body: "{}", headers: {} },
    ])
    let tokenCalls = 0
    const tokenProvider = async () => {
      tokenCalls++
      return `token-${tokenCalls}`
    }
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider })
    await assert.rejects(() => client.get("repos/acme/repo"))
    await client.get("repos/acme/repo")
    assert.equal(tokenCalls, 2)
  })
})

describe("GitHubHttpClient.graphql", () => {
  test("posts to /graphql with query+variables and returns data", async () => {
    const { stub, calls } = makeFetchStub([
      { status: 200, body: JSON.stringify({ data: { viewer: { login: "me" } } }) },
    ])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    const result = await client.graphql<{ viewer: { login: string } }>("query { viewer { login } }", { x: 1 })
    assert.equal(result.kind, "ok")
    if (result.kind !== "ok") throw new Error("unreachable")
    assert.deepEqual(result.data, { viewer: { login: "me" } })

    assert.equal(calls[0].url, "https://api.github.com/graphql")
    assert.equal(calls[0].init?.method, "POST")
    const body = JSON.parse(String(calls[0].init?.body))
    assert.deepEqual(body, { query: "query { viewer { login } }", variables: { x: 1 } })
  })

  test("returns not_modified on 304 even for GraphQL POST", async () => {
    const { stub } = makeFetchStub([{ status: 304, headers: { etag: 'W/"g1"' } }])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    const result = await client.graphql("query", {}, { etag: 'W/"g1"' })
    assert.equal(result.kind, "not_modified")
  })

  test("throws with GraphQL error messages when payload contains errors", async () => {
    const { stub } = makeFetchStub([
      { status: 200, body: JSON.stringify({ errors: [{ message: "boom" }, { message: "bad" }] }) },
    ])
    const client = new GitHubHttpClient({ fetchImpl: stub, tokenProvider: authHeader })
    await assert.rejects(
      () => client.graphql("query", {}),
      (error: unknown) => {
        assert.ok(error instanceof GitHubHttpError)
        assert.match((error as Error).message, /GraphQL error: boom; bad/)
        return true
      },
    )
  })
})

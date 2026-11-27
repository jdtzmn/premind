import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A local stand-in for the parts of the GitHub API the daemon uses:
 * `GET /user`, `GET /repos/{owner}/{repo}/pulls`, and the PR snapshot GraphQL
 * query. Tests mutate pull requests through the returned handle; the daemon
 * sees the change on its next poll.
 *
 * Point a daemon at it with `PREMIND_GITHUB_API_URL=<url>` and
 * `PREMIND_GITHUB_TOKEN=<token>`.
 */

export type FakeCheck = {
  name: string
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED"
  conclusion?: "SUCCESS" | "FAILURE" | "CANCELLED" | "SKIPPED" | "NEUTRAL" | null
  detailsUrl?: string
}

export type FakeIssueComment = { id: number; author: string; body: string; createdAt: string }

export type FakeReview = {
  id: number
  author: string
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
  body: string
  submittedAt: string
}

export type FakePullRequest = {
  repo: string
  number: number
  title: string
  author: string
  headRefName: string
  baseRefName: string
  headRefOid: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  mergeStateStatus: string
  reviewDecision: string | null
  comments: FakeIssueComment[]
  reviews: FakeReview[]
  checks: FakeCheck[]
}

export type FakeGitHubRequest = { method: string; path: string; authorization?: string }

export type FakeGitHub = {
  url: string
  token: string
  viewer: string
  /** Every request received, in order. */
  requests: FakeGitHubRequest[]
  addPullRequest(pr: Pick<FakePullRequest, "repo" | "number" | "headRefName"> & Partial<FakePullRequest>): FakePullRequest
  pullRequest(repo: string, number: number): FakePullRequest
  addComment(repo: string, number: number, comment: { author: string; body: string }): FakeIssueComment
  addReview(repo: string, number: number, review: Pick<FakeReview, "author" | "state"> & { body?: string }): FakeReview
  setCheck(repo: string, number: number, check: FakeCheck): void
  /** Environment that points a daemon at this server. */
  env(): Record<string, string>
  close(): Promise<void>
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export async function startFakeGitHub(options: { viewer?: string; token?: string } = {}): Promise<FakeGitHub> {
  const viewer = options.viewer ?? "premind-test-user"
  const token = options.token ?? "fake-github-token"
  const pulls = new Map<string, FakePullRequest>()
  const requests: FakeGitHubRequest[] = []
  let nextId = 1000
  let clock = Date.parse("2026-01-01T00:00:00Z")
  const timestamp = () => new Date((clock += 1000)).toISOString()

  const key = (repo: string, number: number) => `${repo}#${number}`
  const pullRequest = (repo: string, number: number) => {
    const pr = pulls.get(key(repo, number))
    if (!pr) throw new Error(`fake GitHub has no pull request ${key(repo, number)}`)
    return pr
  }

  const toGraphQL = (pr: FakePullRequest) => ({
    number: pr.number,
    title: pr.title,
    url: `https://github.com/${pr.repo}/pull/${pr.number}`,
    author: { login: pr.author },
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    updatedAt: timestamp(),
    reviewRequests: { nodes: [] },
    reviews: {
      nodes: pr.reviews.map((review) => ({
        databaseId: review.id,
        state: review.state,
        body: review.body,
        submittedAt: review.submittedAt,
        authorAssociation: "COLLABORATOR",
        author: { login: review.author },
      })),
    },
    comments: {
      nodes: pr.comments.map((comment) => ({
        databaseId: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
        author: { login: comment.author },
      })),
    },
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: pr.checks.map((check, index) => ({
                  __typename: "CheckRun",
                  databaseId: index + 1,
                  name: check.name,
                  startedAt: "2026-01-01T00:00:00Z",
                  status: check.status,
                  conclusion: check.conclusion ?? null,
                  detailsUrl: check.detailsUrl ?? `https://github.com/${pr.repo}/actions/runs/${index + 1}`,
                  checkSuite: { workflowRun: { event: "pull_request", workflow: { name: "CI" } } },
                })),
              },
            },
          },
        },
      ],
    },
  })

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-github")
    requests.push({ method: request.method ?? "GET", path: url.pathname + url.search, authorization: request.headers.authorization })
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }

    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" })

    if (request.method === "GET" && url.pathname === "/user") return send(200, { login: viewer })

    const pullsMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)
    if (request.method === "GET" && pullsMatch) {
      const repo = decodeURIComponent(pullsMatch[1])
      const head = url.searchParams.get("head") ?? ""
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head
      const matches = [...pulls.values()].filter(
        (pr) => pr.repo === repo && pr.state === "OPEN" && (!branch || pr.headRefName === branch),
      )
      return send(
        200,
        matches.map((pr) => ({
          number: pr.number,
          title: pr.title,
          html_url: `https://github.com/${pr.repo}/pull/${pr.number}`,
          draft: pr.isDraft,
          state: "open",
          user: { login: pr.author },
        })),
      )
    }

    if (request.method === "POST" && url.pathname === "/graphql") {
      const { variables } = JSON.parse(await readBody(request)) as {
        variables: { owner: string; repo: string; number: number }
      }
      const pr = pulls.get(key(`${variables.owner}/${variables.repo}`, variables.number))
      return send(200, { data: { repository: { pullRequest: pr ? toGraphQL(pr) : null } } })
    }

    send(404, { message: "Not Found" })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    token,
    viewer,
    requests,
    addPullRequest(input) {
      const pr: FakePullRequest = {
        title: `Pull request ${input.number}`,
        author: viewer,
        baseRefName: "main",
        headRefOid: "0000000000000000000000000000000000000001",
        state: "OPEN",
        isDraft: false,
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        comments: [],
        reviews: [],
        checks: [],
        ...input,
      }
      pulls.set(key(pr.repo, pr.number), pr)
      return pr
    },
    pullRequest,
    addComment(repo, number, comment) {
      const added = { id: nextId++, createdAt: timestamp(), ...comment }
      pullRequest(repo, number).comments.push(added)
      return added
    },
    addReview(repo, number, review) {
      const added = { id: nextId++, submittedAt: timestamp(), body: "", ...review }
      pullRequest(repo, number).reviews.push(added)
      return added
    },
    setCheck(repo, number, check) {
      const pr = pullRequest(repo, number)
      pr.checks = [...pr.checks.filter((existing) => existing.name !== check.name), check]
    },
    env: () => ({ PREMIND_GITHUB_API_URL: url, PREMIND_GITHUB_TOKEN: token }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

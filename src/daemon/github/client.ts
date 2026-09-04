import { GitHubHttpClient } from "./http.ts"
import { fetchPullRequestSnapshotGraphQL } from "./graphql.ts"
import { RateLimitTracker } from "./ratelimit.ts"
import type { PullRequestSnapshot } from "./types.ts"

export type PullRequestSummary = {
  number: number
  title: string
  url: string
  draft: boolean
  state: string
  authorLogin?: string | null
}

export type GitHubClientLike = {
  findOpenPullRequestForBranch(
    repo: string,
    branch: string,
    context?: FindOpenPullRequestContext,
  ): Promise<FindOpenPullRequestResult>
  fetchPullRequestSnapshot(
    repo: string,
    prNumber: number,
    context?: FetchSnapshotContext,
  ): Promise<PullRequestSnapshotResult>
  getViewerLogin(): Promise<string | null>
}

/**
 * Optional caller-supplied context for `fetchPullRequestSnapshot`. Used to
 * opt into conditional GraphQL requests with an existing ETag.
 */
export type FetchSnapshotContext = {
  etag?: string | null
}

export type PullRequestSnapshotResult =
  | { kind: "ok"; snapshot: PullRequestSnapshot; etag: string | null }
  | { kind: "not_modified"; etag: string | null }
  | { kind: "not_found" }

/** Caller-supplied ETag for conditional branch-discovery polls. */
export type FindOpenPullRequestContext = {
  etag?: string | null
}

export type FindOpenPullRequestResult =
  | { kind: "ok"; pr: PullRequestSummary | null; etag: string | null }
  | { kind: "not_modified"; etag: string | null }

export type GitHubClientOptions = {
  http?: GitHubHttpClient
}

type PullsListResponse = Array<{
  number: number
  title: string
  html_url: string
  draft: boolean
  state: string
  user: { login?: string | null } | null
}>

/**
 * Production GitHub client.
 *
 * - Branch discovery still uses REST (`GET /repos/{repo}/pulls`) — cheap
 *   (one call per 60s) and ETag-friendly.
 * - PR snapshot uses a single GraphQL query with optional ETag conditional
 *   request, replacing 5 REST calls per poll.
 */
export class GitHubClient implements GitHubClientLike {
  readonly http: GitHubHttpClient
  readonly rateLimit: RateLimitTracker
  private viewerLogin: Promise<string | null> | null = null

  constructor(options: GitHubClientOptions = {}) {
    this.http = options.http ?? new GitHubHttpClient()
    this.rateLimit = this.http.rateLimit
  }

  async getViewerLogin(): Promise<string | null> {
    this.viewerLogin ??= this.http
      .get<{ login?: string | null }>("user")
      .then((response) => (response.kind === "ok" ? response.data.login ?? null : null))
      .catch((error) => {
        this.viewerLogin = null
        throw error
      })
    return this.viewerLogin
  }
  async findOpenPullRequestForBranch(
    repo: string,
    branch: string,
    context: FindOpenPullRequestContext = {},
  ): Promise<FindOpenPullRequestResult> {
    const [owner] = repo.split("/")
    if (!owner || !branch || branch === "HEAD" || branch === "unknown") {
      return { kind: "ok", pr: null, etag: null }
    }

    const path = `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=1`
    const response = await this.http.get<PullsListResponse>(path, {
      etag: context.etag ?? undefined,
    })

    if (response.kind === "not_modified") {
      return { kind: "not_modified", etag: response.etag }
    }

    const first = response.data[0]
    if (!first) return { kind: "ok", pr: null, etag: response.etag }

    return {
      kind: "ok",
      pr: {
        number: first.number,
        title: first.title,
        url: first.html_url,
        draft: first.draft,
        state: first.state,
        authorLogin: first.user?.login ?? null,
      },
      etag: response.etag,
    }
  }

  async fetchPullRequestSnapshot(
    repo: string,
    prNumber: number,
    context: FetchSnapshotContext = {},
  ): Promise<PullRequestSnapshotResult> {
    return fetchPullRequestSnapshotGraphQL(this.http, repo, prNumber, {
      previousEtag: context.etag ?? null,
    })
  }
}

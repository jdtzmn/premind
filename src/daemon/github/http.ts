import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createLogger } from "../logging/logger.ts"
import { RateLimitTracker, type RateLimitResource } from "./ratelimit.ts"

const execFileAsync = promisify(execFile)

const USER_AGENT = "premind-daemon"
const GITHUB_API_BASE = "https://api.github.com"
const DEFAULT_ACCEPT = "application/vnd.github+json"
const API_VERSION = "2022-11-28"

export type GitHubHttpOptions = {
  /** Override the fetch implementation (test seam). */
  fetchImpl?: typeof fetch
  /** Override how the token is resolved (test seam). Defaults to `gh auth token`. */
  tokenProvider?: () => Promise<string>
  /** Rate-limit tracker to report headers into. */
  rateLimit?: RateLimitTracker
  /** Override the base URL (test seam). */
  baseUrl?: string
}

export type GitHubResponse<T> =
  | { kind: "ok"; status: number; data: T; etag: string | null; headers: Headers }
  | { kind: "not_modified"; status: 304; etag: string | null; headers: Headers }

export type ConditionalRequestOptions = {
  /** Send `If-None-Match` with this ETag. A 304 short-circuits with `kind: "not_modified"`. */
  etag?: string | null
  /** Additional headers to merge into the request. */
  headers?: Record<string, string>
}

export class GitHubHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message)
    this.name = "GitHubHttpError"
  }
}

const defaultTokenProvider = async () => {
  const { stdout } = await execFileAsync("gh", ["auth", "token"])
  const token = stdout.trim()
  if (!token) throw new Error("gh auth token returned empty token")
  return token
}

/**
 * Thin wrapper around `fetch` for GitHub REST + GraphQL. Handles:
 * - Token resolution via `gh auth token` (cached, never logged).
 * - User-Agent, Accept, X-GitHub-Api-Version defaults.
 * - X-RateLimit-* / Retry-After ingestion into the provided RateLimitTracker.
 * - `If-None-Match` / 304 short-circuits for conditional requests.
 */
export class GitHubHttpClient {
  private readonly logger = createLogger("daemon.github.http")
  private readonly fetchImpl: typeof fetch
  private readonly tokenProvider: () => Promise<string>
  private readonly baseUrl: string
  readonly rateLimit: RateLimitTracker
  private cachedToken: string | null = null

  constructor(options: GitHubHttpOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider
    this.baseUrl = options.baseUrl ?? GITHUB_API_BASE
    this.rateLimit = options.rateLimit ?? new RateLimitTracker()
  }

  /** Force a token refresh on the next request (e.g. after a 401). */
  invalidateToken() {
    this.cachedToken = null
  }

  /**
   * GET {path}. `path` may be absolute (`https://...`) or a REST path like
   * `repos/{owner}/{repo}/pulls`. The leading slash is optional.
   */
  async get<T>(path: string, options: ConditionalRequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = this.resolveUrl(path)
    const headers = await this.buildHeaders(options.headers)
    if (options.etag) headers["If-None-Match"] = options.etag

    const response = await this.fetchImpl(url, { method: "GET", headers })
    this.ingestRateLimit(response)

    const etag = response.headers.get("etag")

    if (response.status === 304) {
      return { kind: "not_modified", status: 304, etag, headers: response.headers }
    }

    if (!response.ok) {
      await this.throwForResponse(response)
    }

    const data = (await response.json()) as T
    return { kind: "ok", status: response.status, data, etag, headers: response.headers }
  }

  /**
   * POST to the GraphQL endpoint. Supports conditional requests via
   * `If-None-Match` and the same rate-limit parsing.
   */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    options: ConditionalRequestOptions = {},
  ): Promise<GitHubResponse<T>> {
    const url = this.resolveUrl("graphql")
    const headers = await this.buildHeaders({ "Content-Type": "application/json", ...options.headers })
    if (options.etag) headers["If-None-Match"] = options.etag

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    })
    this.ingestRateLimit(response)

    const etag = response.headers.get("etag")

    if (response.status === 304) {
      return { kind: "not_modified", status: 304, etag, headers: response.headers }
    }

    if (!response.ok) {
      await this.throwForResponse(response)
    }

    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((error) => error.message).join("; ")
      throw new GitHubHttpError(`GraphQL error: ${message}`, response.status, JSON.stringify(payload.errors), null)
    }
    if (payload.data === undefined) {
      throw new GitHubHttpError("GraphQL response missing data", response.status, "", null)
    }
    return { kind: "ok", status: response.status, data: payload.data, etag, headers: response.headers }
  }

  private resolveUrl(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path
    const normalized = path.startsWith("/") ? path.slice(1) : path
    return `${this.baseUrl}/${normalized}`
  }

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.getToken()
    return {
      Accept: DEFAULT_ACCEPT,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      Authorization: `Bearer ${token}`,
      ...(extra ?? {}),
    }
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken
    this.cachedToken = await this.tokenProvider()
    return this.cachedToken
  }

  private ingestRateLimit(response: Response) {
    this.rateLimit.ingest(response.headers)
  }

  private async throwForResponse(response: Response): Promise<never> {
    const body = await response.text().catch(() => "")
    const retryAfterRaw = response.headers.get("retry-after")
    const retryAfterSeconds = retryAfterRaw !== null ? Number.parseInt(retryAfterRaw, 10) : null
    const resource = inferResource(response)

    if ((response.status === 403 || response.status === 429) && Number.isFinite(retryAfterSeconds)) {
      this.rateLimit.recordRetryAfter(resource, retryAfterSeconds as number)
    }

    if (response.status === 401) {
      // Force token refresh on next call in case it rotated.
      this.invalidateToken()
    }

    // NEVER include Authorization or token in logs or error bodies.
    this.logger.warn("github http error", {
      status: response.status,
      resource,
      retryAfterSeconds: retryAfterRaw,
      snippet: body.slice(0, 200),
    })

    throw new GitHubHttpError(
      `GitHub request failed with status ${response.status}`,
      response.status,
      body,
      Number.isFinite(retryAfterSeconds) ? (retryAfterSeconds as number) : null,
    )
  }
}

const inferResource = (response: Response): RateLimitResource => {
  const resource = response.headers.get("x-ratelimit-resource")
  if (resource === "graphql") return "graphql"
  if (resource === "search") return "search"
  if (resource === "core") return "core"
  return "other"
}

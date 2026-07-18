import type { GitHubHttpClient } from "./http.ts"
import type {
  PullRequestCheck,
  PullRequestCore,
  PullRequestIssueComment,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestSnapshot,
} from "./types.ts"

/**
 * Single GraphQL query returning everything the diff algorithm needs:
 *
 * - PR core metadata (title/state/isDraft/mergeable/reviewDecision/head oid/review requests)
 * - Recent reviews (we take the most recent 100 — sufficient for diffing)
 * - Recent issue comments (top-level PR conversation)
 * - Recent review thread comments (inline code comments), flattened from threads
 * - Status check rollup for the head commit (succeeded/failed/pending/in_progress)
 *
 * This replaces 5 REST calls per poll with 1 GraphQL call.
 */
export const PR_SNAPSHOT_QUERY = /* GraphQL */ `
  query PullRequestSnapshot($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        url
        state
        isDraft
        headRefName
        baseRefName
        headRefOid
        mergeStateStatus
        reviewDecision
        updatedAt
        reviewRequests(first: 50) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
              ... on Mannequin { login }
            }
          }
        }
        reviews(last: 100) {
          nodes {
            databaseId
            state
            body
            submittedAt
            authorAssociation
            author { login }
          }
        }
        comments(last: 100) {
          nodes {
            databaseId
            body
            createdAt
            updatedAt
            author { login }
          }
        }
        reviewThreads(last: 100) {
          nodes {
            comments(first: 50) {
              nodes {
                databaseId
                body
                createdAt
                updatedAt
                path
                line
                originalLine
                author { login }
              }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                      checkSuite {
                        workflowRun { event workflow { name } }
                      }
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

type ReviewerNode = {
  requestedReviewer?:
    | ({ __typename: "User" | "Mannequin"; login?: string | null } | { __typename: "Team"; slug?: string | null })
    | null
}

type ReviewNode = {
  databaseId: number | null
  state?: string | null
  body?: string | null
  submittedAt?: string | null
  authorAssociation?: string | null
  author?: { login?: string | null } | null
}

type IssueCommentNode = {
  databaseId: number | null
  body?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  author?: { login?: string | null } | null
}

type ReviewCommentNode = {
  databaseId: number | null
  body?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  path?: string | null
  line?: number | null
  originalLine?: number | null
  author?: { login?: string | null } | null
}

type CheckRunNode = {
  __typename: "CheckRun"
  name?: string | null
  status?: string | null
  conclusion?: string | null
  detailsUrl?: string | null
  checkSuite?: { workflowRun?: { event?: string | null; workflow?: { name?: string | null } | null } | null } | null
}

type StatusContextNode = {
  __typename: "StatusContext"
  context?: string | null
  state?: string | null
  targetUrl?: string | null
}

type CheckContextNode = CheckRunNode | StatusContextNode | { __typename: string }

type PullRequestQueryData = {
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
      mergeStateStatus?: string | null
      reviewDecision?: string | null
      updatedAt?: string | null
      reviewRequests: { nodes: (ReviewerNode | null)[] }
      reviews: { nodes: (ReviewNode | null)[] }
      comments: { nodes: (IssueCommentNode | null)[] }
      reviewThreads: { nodes: { comments: { nodes: (ReviewCommentNode | null)[] } }[] }
      commits: {
        nodes: {
          commit: { statusCheckRollup?: { contexts: { nodes: (CheckContextNode | null)[] } } | null }
        }[]
      }
    } | null
  } | null
}

const nonNull = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined

const extractReviewerLogin = (node: ReviewerNode | null): string | null => {
  const requested = node?.requestedReviewer
  if (!requested) return null
  if (requested.__typename === "Team") {
    const team = requested as { __typename: "Team"; slug?: string | null }
    return team.slug ? `team:${team.slug}` : null
  }
  const user = requested as { __typename: string; login?: string | null }
  return user.login ?? null
}

/**
 * Map GraphQL `CheckRun.status` + `conclusion` onto the existing REST-style
 * `state` field that diff.ts understands. Mirrors the values produced by
 * `gh pr checks --json state`, which returns one of: pass, fail, pending,
 * in_progress, skipping, cancelled, neutral, action_required.
 */
const mapCheckRunState = (status?: string | null, conclusion?: string | null): string => {
  const s = (status ?? "").toUpperCase()
  const c = (conclusion ?? "").toUpperCase()
  if (s === "COMPLETED") {
    if (c === "SUCCESS") return "pass"
    if (c === "FAILURE" || c === "TIMED_OUT" || c === "STARTUP_FAILURE") return "fail"
    if (c === "CANCELLED") return "cancelled"
    if (c === "SKIPPED") return "skipping"
    if (c === "NEUTRAL") return "neutral"
    if (c === "ACTION_REQUIRED") return "action_required"
    return c.toLowerCase() || "pass"
  }
  if (s === "IN_PROGRESS") return "in_progress"
  if (s === "QUEUED" || s === "PENDING" || s === "REQUESTED" || s === "WAITING") return "pending"
  return s.toLowerCase() || "pending"
}

const mapStatusContextState = (state?: string | null): string => {
  const s = (state ?? "").toUpperCase()
  if (s === "SUCCESS") return "pass"
  if (s === "FAILURE" || s === "ERROR") return "fail"
  if (s === "PENDING" || s === "EXPECTED") return "pending"
  return s.toLowerCase() || "pending"
}

const toCheck = (node: CheckContextNode | null): PullRequestCheck | null => {
  if (!node) return null
  if (node.__typename === "CheckRun") {
    const run = node as CheckRunNode
    return {
      name: run.name ?? "",
      state: mapCheckRunState(run.status, run.conclusion),
      link: run.detailsUrl ?? undefined,
      event: run.checkSuite?.workflowRun?.event ?? undefined,
      workflow: run.checkSuite?.workflowRun?.workflow?.name ?? undefined,
    }
  }
  if (node.__typename === "StatusContext") {
    const context = node as StatusContextNode
    return {
      name: context.context ?? "",
      state: mapStatusContextState(context.state),
      link: context.targetUrl ?? undefined,
    }
  }
  return null
}

const toReview = (node: ReviewNode | null): PullRequestReview | null => {
  if (!node || node.databaseId === null || node.databaseId === undefined) return null
  return {
    id: node.databaseId,
    state: node.state ?? undefined,
    body: node.body ?? null,
    submitted_at: node.submittedAt ?? undefined,
    authorAssociation: node.authorAssociation ?? undefined,
    user: node.author?.login ? { login: node.author.login } : undefined,
  }
}

const toIssueComment = (node: IssueCommentNode | null): PullRequestIssueComment | null => {
  if (!node || node.databaseId === null || node.databaseId === undefined) return null
  return {
    id: node.databaseId,
    body: node.body ?? null,
    created_at: node.createdAt ?? undefined,
    updated_at: node.updatedAt ?? undefined,
    user: node.author?.login ? { login: node.author.login } : undefined,
  }
}

const toReviewComment = (node: ReviewCommentNode | null): PullRequestReviewComment | null => {
  if (!node || node.databaseId === null || node.databaseId === undefined) return null
  return {
    id: node.databaseId,
    body: node.body ?? null,
    created_at: node.createdAt ?? undefined,
    updated_at: node.updatedAt ?? undefined,
    path: node.path ?? undefined,
    line: node.line ?? node.originalLine ?? null,
    user: node.author?.login ? { login: node.author.login } : undefined,
  }
}

export type PrSnapshotFetchResult =
  | { kind: "ok"; snapshot: PullRequestSnapshot; etag: string | null }
  | { kind: "not_modified"; etag: string | null }
  | { kind: "not_found" }

/**
 * Fetch a full PR snapshot via a single GraphQL call.
 *
 * When `previousEtag` is provided an `If-None-Match` header is sent; a 304
 * response short-circuits with `kind: "not_modified"` so the caller can reuse
 * the cached snapshot and skip diffing entirely.
 */
export async function fetchPullRequestSnapshotGraphQL(
  http: GitHubHttpClient,
  repo: string,
  prNumber: number,
  options: { previousEtag?: string | null; now?: () => number } = {},
): Promise<PrSnapshotFetchResult> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`)

  const response = await http.graphql<PullRequestQueryData>(
    PR_SNAPSHOT_QUERY,
    { owner, repo: name, number: prNumber },
    { etag: options.previousEtag ?? undefined },
  )

  if (response.kind === "not_modified") {
    return { kind: "not_modified", etag: response.etag }
  }

  const pr = response.data.repository?.pullRequest
  if (!pr) return { kind: "not_found" }

  const reviewRequests = (pr.reviewRequests.nodes ?? [])
    .map((node) => extractReviewerLogin(node))
    .filter(nonNull)
    .map((login) => ({ login }))

  const reviews = (pr.reviews.nodes ?? []).map(toReview).filter(nonNull)
  const issueComments = (pr.comments.nodes ?? []).map(toIssueComment).filter(nonNull)
  const reviewComments = (pr.reviewThreads.nodes ?? [])
    .flatMap((thread) => thread.comments.nodes ?? [])
    .map(toReviewComment)
    .filter(nonNull)

  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const checks = contexts.map(toCheck).filter(nonNull)

  const core: PullRequestCore = {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus ?? undefined,
    reviewDecision: pr.reviewDecision ?? null,
    updatedAt: pr.updatedAt ?? undefined,
    reviewRequests,
  }

  const nowFn = options.now ?? Date.now
  const snapshot: PullRequestSnapshot = {
    core,
    reviews,
    issueComments,
    reviewComments,
    checks,
    fetchedAt: nowFn(),
  }

  return { kind: "ok", snapshot, etag: response.etag }
}

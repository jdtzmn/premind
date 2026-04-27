export type PullRequestCore = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  headRefOid: string
  mergeStateStatus?: string
  reviewDecision?: string | null
  updatedAt?: string
  reviewRequests?: Array<{ login: string }>
}

export type PullRequestReview = {
  id: number
  state?: string
  body?: string | null
  submitted_at?: string
  authorAssociation?: string
  user?: { login?: string }
}

export type PullRequestIssueComment = {
  id: number
  body?: string | null
  created_at?: string
  updated_at?: string
  user?: { login?: string }
}

export type PullRequestReviewComment = {
  id: number
  body?: string | null
  created_at?: string
  updated_at?: string
  path?: string
  line?: number | null
  user?: { login?: string }
}

export type PullRequestCheck = {
  name: string
  state?: string
  link?: string
  event?: string
  workflow?: string
}

export type PullRequestSnapshot = {
  core: PullRequestCore
  reviews: PullRequestReview[]
  issueComments: PullRequestIssueComment[]
  reviewComments: PullRequestReviewComment[]
  checks: PullRequestCheck[]
  fetchedAt: number
}

export type NormalizedPrEvent = {
  dedupeKey: string
  kind: string
  priority: "high" | "medium" | "low"
  summary: string
  /**
   * Pointer to where richer information about this event lives.
   * Pre-persistence this is always a GitHub URL (PR page or check job link).
   * After insertEvents runs, the persistence layer may overwrite the stored
   * value with a local detail-file path for event kinds that carry rich body
   * content (comments, reviews). The reminder template treats both
   * identically — it just renders the link in parentheses.
   */
  referenceLink?: string
  payload: Record<string, unknown>
}

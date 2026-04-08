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
  detailFilePath?: string
  payload: Record<string, unknown>
}

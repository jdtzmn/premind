import type { NormalizedPrEvent, PullRequestCheck, PullRequestSnapshot } from "./types.js"

const compact = (value: string | null | undefined, max = 160) => {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

const checkKind = (state?: string) => {
  const normalized = (state ?? "").toLowerCase()
  if (["pass", "success", "succeeded"].includes(normalized)) return "check.succeeded"
  if (["fail", "failed", "failure"].includes(normalized)) return "check.failed"
  if (["pending", "queued"].includes(normalized)) return "check.queued"
  if (["running", "in_progress"].includes(normalized)) return "check.in_progress"
  return "check.created"
}

const checkPriority = (kind: string): NormalizedPrEvent["priority"] => {
  if (kind === "check.failed") return "high"
  if (kind === "check.succeeded") return "medium"
  return "low"
}

const checkSummary = (check: PullRequestCheck, kind: string) => {
  const name = check.name || "unnamed check"
  if (kind === "check.failed") return `Check failed: ${name}`
  if (kind === "check.succeeded") return `Check passed: ${name}`
  if (kind === "check.in_progress") return `Check started: ${name}`
  if (kind === "check.queued") return `Check queued: ${name}`
  return `New check detected: ${name}`
}

const wasEdited = (
  previousBody: string | null | undefined,
  nextBody: string | null | undefined,
  previousUpdatedAt: string | undefined,
  nextUpdatedAt: string | undefined,
) => {
  const prev = (previousBody ?? "").trim()
  const next = (nextBody ?? "").trim()
  return prev !== next || (previousUpdatedAt ?? "") !== (nextUpdatedAt ?? "")
}

export function diffSnapshot(previous: PullRequestSnapshot | null, next: PullRequestSnapshot): NormalizedPrEvent[] {
  if (!previous) {
    return [
      {
        dedupeKey: `pr.snapshot.initial:${next.core.number}:${next.core.headRefOid}`,
        kind: "pr.snapshot.initialized",
        priority: "low",
        summary: `Started tracking ${next.core.number}: ${next.core.title}`,
        detailFilePath: next.core.url,
        payload: {
          prNumber: next.core.number,
          headSha: next.core.headRefOid,
          reviewDecision: next.core.reviewDecision ?? null,
        },
      },
    ]
  }

  const events: NormalizedPrEvent[] = []

  if (previous.core.isDraft && !next.core.isDraft) {
    events.push({
      dedupeKey: `pr.ready_for_review:${next.core.number}:${next.core.headRefOid}`,
      kind: "pr.ready_for_review",
      priority: "high",
      summary: `PR is ready for review: ${next.core.title}`,
      detailFilePath: next.core.url,
      payload: { prNumber: next.core.number },
    })
  }

  if (!previous.core.isDraft && next.core.isDraft) {
    events.push({
      dedupeKey: `pr.converted_to_draft:${next.core.number}:${next.core.headRefOid}`,
      kind: "pr.converted_to_draft",
      priority: "medium",
      summary: `PR moved back to draft: ${next.core.title}`,
      detailFilePath: next.core.url,
      payload: { prNumber: next.core.number },
    })
  }

  if (previous.core.headRefOid !== next.core.headRefOid) {
    events.push({
      dedupeKey: `pr.synchronized:${next.core.number}:${next.core.headRefOid}`,
      kind: "pr.synchronized",
      priority: "medium",
      summary: `New commits pushed to PR #${next.core.number}`,
      detailFilePath: next.core.url,
      payload: { previousHeadSha: previous.core.headRefOid, headSha: next.core.headRefOid },
    })
  }

  if (previous.core.mergeStateStatus !== next.core.mergeStateStatus) {
    const nextState = (next.core.mergeStateStatus ?? "").toUpperCase()
    if (nextState === "DIRTY") {
      events.push({
        dedupeKey: `merge_conflict.detected:${next.core.number}:${next.core.headRefOid}`,
        kind: "merge_conflict.detected",
        priority: "high",
        summary: `Merge conflicts detected for PR #${next.core.number}`,
        detailFilePath: next.core.url,
        payload: { mergeStateStatus: next.core.mergeStateStatus ?? null },
      })
    }
    if (nextState === "CLEAN") {
      events.push({
        dedupeKey: `merge_conflict.cleared:${next.core.number}:${next.core.headRefOid}`,
        kind: "merge_conflict.cleared",
        priority: "medium",
        summary: `Merge conflicts cleared for PR #${next.core.number}`,
        detailFilePath: next.core.url,
        payload: { mergeStateStatus: next.core.mergeStateStatus ?? null },
      })
    }
  }

  const previousReviewIds = new Set(previous.reviews.map((review) => review.id))
  for (const review of next.reviews) {
    if (previousReviewIds.has(review.id)) continue
    const state = (review.state ?? "COMMENTED").toUpperCase()
    const user = review.user?.login ?? "unknown"
    const kind =
      state === "APPROVED"
        ? "review.approved"
        : state === "CHANGES_REQUESTED"
          ? "review.changes_requested"
          : "review.commented"
    events.push({
      dedupeKey: `${kind}:${review.id}`,
      kind,
      priority: kind === "review.changes_requested" || kind === "review.approved" ? "high" : "medium",
      summary: `${user} ${kind.replace("review.", "").replaceAll("_", " ")}${compact(review.body) ? `: ${compact(review.body)}` : ""}`,
      detailFilePath: next.core.url,
      payload: {
        reviewId: review.id,
        user,
        state,
        body: review.body ?? null,
      },
    })
  }

  const previousIssueCommentIds = new Set(previous.issueComments.map((comment) => comment.id))
  const previousIssueComments = new Map(previous.issueComments.map((comment) => [comment.id, comment]))
  for (const comment of next.issueComments) {
    const previousComment = previousIssueComments.get(comment.id)
    if (previousComment) {
      if (
        wasEdited(previousComment.body, comment.body, previousComment.updated_at, comment.updated_at)
      ) {
        const user = comment.user?.login ?? previousComment.user?.login ?? "unknown"
        events.push({
          dedupeKey: `issue_comment.edited:${comment.id}:${comment.updated_at ?? "unknown"}`,
          kind: "issue_comment.edited",
          priority: "medium",
          summary: `Issue comment edited by ${user}${compact(comment.body) ? `: ${compact(comment.body)}` : ""}`,
          detailFilePath: next.core.url,
          payload: {
            commentId: comment.id,
            user,
            previousBody: previousComment.body ?? null,
            body: comment.body ?? null,
            updatedAt: comment.updated_at ?? null,
          },
        })
      }
      continue
    }
    if (previousIssueCommentIds.has(comment.id)) continue
    const user = comment.user?.login ?? "unknown"
    events.push({
      dedupeKey: `issue_comment.created:${comment.id}`,
      kind: "issue_comment.created",
      priority: "high",
      summary: `New issue comment from ${user}${compact(comment.body) ? `: ${compact(comment.body)}` : ""}`,
      detailFilePath: next.core.url,
      payload: {
        commentId: comment.id,
        user,
        body: comment.body ?? null,
      },
    })
  }

  const previousReviewCommentIds = new Set(previous.reviewComments.map((comment) => comment.id))
  const previousReviewComments = new Map(previous.reviewComments.map((comment) => [comment.id, comment]))
  for (const comment of next.reviewComments) {
    const previousComment = previousReviewComments.get(comment.id)
    if (previousComment) {
      if (
        wasEdited(previousComment.body, comment.body, previousComment.updated_at, comment.updated_at)
      ) {
        const user = comment.user?.login ?? previousComment.user?.login ?? "unknown"
        const location = comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""
        events.push({
          dedupeKey: `review_comment.edited:${comment.id}:${comment.updated_at ?? "unknown"}`,
          kind: "review_comment.edited",
          priority: "medium",
          summary: `Review comment edited by ${user}${location}${compact(comment.body) ? `: ${compact(comment.body)}` : ""}`,
          detailFilePath: next.core.url,
          payload: {
            commentId: comment.id,
            user,
            previousBody: previousComment.body ?? null,
            body: comment.body ?? null,
            path: comment.path ?? null,
            line: comment.line ?? null,
            updatedAt: comment.updated_at ?? null,
          },
        })
      }
      continue
    }
    if (previousReviewCommentIds.has(comment.id)) continue
    const user = comment.user?.login ?? "unknown"
    const location = comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""
    events.push({
      dedupeKey: `review_comment.created:${comment.id}`,
      kind: "review_comment.created",
      priority: "high",
      summary: `New review comment from ${user}${location}${compact(comment.body) ? `: ${compact(comment.body)}` : ""}`,
      detailFilePath: next.core.url,
      payload: {
        commentId: comment.id,
        user,
        body: comment.body ?? null,
        path: comment.path ?? null,
        line: comment.line ?? null,
      },
    })
  }

  const previousChecks = new Map(previous.checks.map((check) => [check.name, check]))
  for (const check of next.checks) {
    const prev = previousChecks.get(check.name)
    const kind = checkKind(check.state)
    if (prev && prev.state === check.state) continue
    events.push({
      dedupeKey: `${kind}:${check.name}:${next.core.headRefOid}`,
      kind,
      priority: checkPriority(kind),
      summary: checkSummary(check, kind),
      detailFilePath: check.link ?? next.core.url,
      payload: {
        name: check.name,
        state: check.state ?? null,
        workflow: check.workflow ?? null,
        event: check.event ?? null,
      },
    })
  }

  return events
}

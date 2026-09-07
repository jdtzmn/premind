import type { ReminderEvent } from "../../shared/schema.ts"
import type { PullRequestCheck, PullRequestSnapshot } from "../github/types.ts"

export type ReminderSourceEvent = {
  seq: number
  kind: string
  priority: "high" | "medium" | "low"
  summary: string
  reference_link: string | null
  payload_json: string
}

// Durable provenance survives condensation and partial group reconciliation.
// These IDs refer to immutable pr_events rows, not individual nested check jobs.
export type RenderedReminderEvent = ReminderEvent & {
  sourceEventIds?: string[]
  count?: number
  samples?: string[]
}
type Candidate = {
  event: RenderedReminderEvent
  payload: Record<string, unknown>
}
type Reconciled = {
  event: RenderedReminderEvent
  actionable?: boolean
  reviewAction?: boolean
  unverified?: boolean
  supersededHead?: string
}
const shortSha = (sha: string) => sha.slice(0, 7)
const priorityRank = { high: 0, medium: 1, low: 2 }
const checkKinds = new Set(["check.failed", "check.cancelled"])
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
const parsePayload = (json: string) => {
  try { return object(JSON.parse(json)) } catch { return {} }
}
const checkState = (check: PullRequestCheck) => {
  const state = (check.state ?? "").toLowerCase()
  if (["pass", "success", "succeeded"].includes(state)) return "passed"
  if (["fail", "failed", "failure"].includes(state)) return "failed"
  if (["cancelled", "canceled"].includes(state)) return "cancelled"
  if (["pending", "queued", "running", "in_progress", "waiting", "requested"].includes(state)) return "active"
  return "unverified"
}

/** No run IDs/timestamps exist in the stored check schema. Duplicate terminal
 * fail+pass results cannot be ordered: verify, rather than inventing a newest run.
 * An explicitly active rerun of the same identity retains the existing policy of
 * deferring action until it finishes. Sibling names/cancellations are not evidence.
 */
const currentCheckState = (payload: Record<string, unknown>, checks: PullRequestCheck[]) => {
  if (typeof payload.name !== "string") return "unverified"
  const matches = checks.filter((check) => check.name === payload.name &&
    (typeof payload.workflow !== "string" || check.workflow === payload.workflow) &&
    (typeof payload.event !== "string" || check.event === payload.event))
  if (!matches.length) return "unverified"
  const identities = new Set(matches.map((check) => JSON.stringify([check.workflow ?? null, check.event ?? null])))
  if (identities.size > 1) return "unverified"
  const states = new Set(matches.map(checkState))
  if (states.has("active")) return "active"
  return states.size === 1 ? states.values().next().value! : "unverified"
}

const mergeState = (snapshot: PullRequestSnapshot) => {
  const state = (snapshot.core.mergeStateStatus ?? "UNKNOWN").toUpperCase()
  return state === "UNKNOWN" ? (snapshot.core.lastStableMergeStateStatus ?? "UNKNOWN").toUpperCase() : state
}
const terminal = (snapshot: PullRequestSnapshot) => ["CLOSED", "MERGED"].includes(snapshot.core.state.toUpperCase())
const informational = (event: RenderedReminderEvent, kind: string, summary: string): Reconciled => ({
  event: { ...event, kind, priority: "low", summary },
})
const unverified = (event: RenderedReminderEvent, kind = event.kind): Reconciled => ({
  ...informational(event, kind, `UNVERIFIED history: ${event.summary}. Verify current status before acting.`),
  unverified: true,
})

const reconcileInitial = (event: RenderedReminderEvent, snapshot: PullRequestSnapshot | null): Reconciled => {
  if (!snapshot) return unverified(event)
  const base = `Started tracking ${snapshot.core.number}: ${snapshot.core.title}`
  if (terminal(snapshot)) return informational(event, event.kind, `${base} — PR ${snapshot.core.state.toUpperCase()}; historical blockers are not actionable`)
  const blockers: string[] = []
  const state = mergeState(snapshot)
  if (state === "DIRTY") blockers.push("merge conflicts present")
  const failingChecks = snapshot.checks.filter((check) =>
    currentCheckState({ name: check.name, workflow: check.workflow, event: check.event }, snapshot.checks) === "failed")
  const names = [...new Set(failingChecks.map((check) => check.name || "unnamed check"))]
  if (names.length) blockers.push(`${names.length} check${names.length === 1 ? "" : "s"} failing (${names.join(", ")})`)
  // Review feedback has a distinct assess/address policy, not a CI-fix imperative.
  if (snapshot.core.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested")
  const uncertainChecks = snapshot.checks.some((check) =>
    currentCheckState({ name: check.name, workflow: check.workflow, event: check.event }, snapshot.checks) === "unverified")
  const uncertain = !["DIRTY", "CLEAN"].includes(state) || uncertainChecks
  if (uncertain) blockers.push("UNVERIFIED blocker status; verify current status before acting")
  return {
    event: { ...event, summary: blockers.length ? `${base} — ${blockers.join("; ")}` : base,
      priority: state === "DIRTY" || names.length > 0 || snapshot.core.reviewDecision === "CHANGES_REQUESTED" ? "high" : "low" },
    actionable: state === "DIRTY" || names.length > 0,
    reviewAction: snapshot.core.reviewDecision === "CHANGES_REQUESTED",
    unverified: uncertain,
  }
}

const reviewKinds = new Set(["review.changes_requested", "pr.review_decision.changes_requested"])
const reconcileReview = ({ event, payload }: Candidate, snapshot: PullRequestSnapshot | null): Reconciled => {
  if (!snapshot) return unverified(event, "review.unverified")
  if (terminal(snapshot)) return informational(event, "review.historical",
    `Historical review feedback — PR ${snapshot.core.state.toUpperCase()}; no review action required`)
  const decision = snapshot.core.reviewDecision?.toUpperCase()
  const resolved = () => informational(event, "review.resolved", `No longer requesting changes: ${event.summary}`)
  if (decision === "APPROVED") return resolved()
  if (event.kind === "pr.review_decision.changes_requested") {
    if (decision === "CHANGES_REQUESTED") return { event, reviewAction: true }
    if (decision === "REVIEW_REQUIRED") return resolved()
    return unverified(event, "review.unverified")
  }
  const review = snapshot.reviews.find((candidate) => candidate.id === payload.reviewId)
  if (!review) return unverified(event, "review.unverified")
  if (["APPROVED", "DISMISSED"].includes((review.state ?? "").toUpperCase())) return resolved()
  // A newer decisive review by the same author supersedes their old request.
  // Do not order reviews by array position or assume IDs encode submission time.
  const login = review.user?.login?.toLowerCase()
  const submitted = Date.parse(review.submitted_at ?? "")
  const newer = login && Number.isFinite(submitted) ? snapshot.reviews.filter((candidate) =>
    candidate.user?.login?.toLowerCase() === login &&
    Date.parse(candidate.submitted_at ?? "") > submitted &&
    ["APPROVED", "CHANGES_REQUESTED"].includes((candidate.state ?? "").toUpperCase())) : []
  const latest = newer.sort((left, right) => Date.parse(right.submitted_at!) - Date.parse(left.submitted_at!))[0]
  if (latest?.state?.toUpperCase() === "APPROVED") return resolved()
  if ((review.state ?? "").toUpperCase() === "CHANGES_REQUESTED") return { event, reviewAction: true }
  return unverified(event, "review.unverified")
}

const reconcile = ({ event, payload }: Candidate, snapshot: PullRequestSnapshot | null): Reconciled => {
  if (event.kind === "pr.snapshot.initialized") return reconcileInitial(event, snapshot)
  if (reviewKinds.has(event.kind)) return reconcileReview({ event, payload }, snapshot)
  if (!checkKinds.has(event.kind) && event.kind !== "merge_conflict.detected") return { event }
  if (snapshot && terminal(snapshot)) return informational(event, `${event.kind.split(".")[0]}.historical`,
    `Historical: ${event.summary} — PR ${snapshot.core.state.toUpperCase()}; no blocker action required`)
  if (event.kind === "merge_conflict.detected") {
    if (!snapshot) return unverified(event, "merge_conflict.unverified")
    const state = mergeState(snapshot)
    if (state === "DIRTY") return { event, actionable: true }
    if (state === "CLEAN") return informational(event, "merge_conflict.resolved", "Previously detected merge conflicts are now cleared (CLEAN)")
    return unverified(event, "merge_conflict.unverified")
  }
  const head = payload.headSha
  if (snapshot?.core.headRefOid && typeof head === "string" && head && head !== snapshot.core.headRefOid) {
    return { event, supersededHead: head }
  }
  if (!snapshot || typeof head !== "string" || !head || !snapshot.core.headRefOid) return unverified(event, "check.unverified")
  const state = currentCheckState(payload, snapshot.checks)
  if (state === "unverified") return unverified(event, "check.unverified")
  if (state === "failed") return {
    event: { ...event, kind: "check.failed", priority: "high", summary: `Check failed: ${payload.name || "unnamed check"}` }, actionable: true,
  }
  return informational(event, state === "active" ? "check.rerunning" : "check.resolved",
    `Previously ${event.kind === "check.failed" ? "failed" : "cancelled"} check ${payload.name || "unnamed check"}: ${state === "active" ? "active rerun; wait for its result" : `now ${state}`}`)
}

const expand = (row: ReminderSourceEvent): Candidate[] => {
  const payload = parsePayload(row.payload_json)
  const event: RenderedReminderEvent = {
    eventId: String(row.seq), sourceEventIds: [String(row.seq)], kind: row.kind,
    priority: row.priority, summary: row.summary,
    ...(row.reference_link ? { referenceLink: row.reference_link } : {}),
  }
  if ((checkKinds.has(row.kind) || reviewKinds.has(row.kind)) && Array.isArray(payload.events) && payload.events.length) {
    return payload.events.map((child) => {
      const nested = object(child)
      return { event: { ...event, summary: typeof nested.summary === "string" ? nested.summary : row.summary },
        payload: { ...payload, ...object(nested.payload) } }
    })
  }
  return [{ event, payload }]
}
const sourceIds = (events: RenderedReminderEvent[]) => [...new Set(events.flatMap((event) => event.sourceEventIds ?? [event.eventId]))]

export function renderReminder(
  rows: ReminderSourceEvent[], snapshot: PullRequestSnapshot | null,
  target: { repo: string; prNumber?: number; source?: "automatic" | "manual" },
) {
  const reconciled = rows.flatMap(expand).map((candidate) => reconcile(candidate, snapshot))
  const live = reconciled.filter((item) => !item.supersededHead)
  const grouped = new Map<string, RenderedReminderEvent[]>()
  for (const { event } of live) {
    const key = event.priority === "high" ? `${event.eventId}:${grouped.size}` : `${event.priority}:${event.kind}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(event)
    else grouped.set(key, [event])
  }
  const condensedLive = [...grouped.values()].map((bucket) => bucket.length === 1 ? bucket[0]! : {
    ...bucket[0]!, sourceEventIds: sourceIds(bucket), count: bucket.length,
    samples: bucket.slice(0, 2).map((event) => event.summary),
    summary: `${bucket.length} ${bucket[0]!.kind.replaceAll("_", " ")} events (${bucket.slice(0, 2).map((event) => event.summary).join("; ")})`,
  }).sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || Number(left.eventId) - Number(right.eventId))
  const superseded = new Map<string, RenderedReminderEvent[]>()
  for (const { event, supersededHead } of reconciled) {
    if (!supersededHead) continue
    const bucket = superseded.get(supersededHead)
    if (bucket) bucket.push(event)
    else superseded.set(supersededHead, [event])
  }
  const supersededSummaries: RenderedReminderEvent[] = [...superseded].map(([head, bucket]) => {
    const failed = bucket.filter((event) => event.kind === "check.failed").length
    const cancelled = bucket.length - failed
    const parts = [...(failed ? [`${failed} failed`] : []), ...(cancelled ? [`${cancelled} cancelled`] : [])]
    return { eventId: bucket.at(-1)!.eventId, sourceEventIds: sourceIds(bucket), kind: "check.superseded", priority: "low",
      summary: `${parts.join(", ")} on ${shortSha(head)} (superseded by ${shortSha(snapshot!.core.headRefOid)})`, count: bucket.length }
  })
  const renderEvent = (event: ReminderEvent, index: number) => `${index + 1}. ${event.kind} - ${event.summary}${event.referenceLink ? ` (${event.referenceLink})` : ""}`
  const qualified = target.prNumber ? `${target.repo}#${target.prNumber}` : target.repo
  const reminderText = [
    "<system-reminder>",
    `PR update for ${qualified}${snapshot?.core.headRefOid ? ` (HEAD: ${shortSha(snapshot.core.headRefOid)})` : ""}:`,
    ...(target.source === "manual" ? ["", "This PR is manually subscribed. Do not make changes unless the user explicitly asks you to."] : []),
    ...(condensedLive.length ? ["", "Changes:", ...condensedLive.map(renderEvent)] : []),
    ...(supersededSummaries.length ? ["", "Superseded:", ...supersededSummaries.map(renderEvent)] : []),
    ...(live.some((item) => item.actionable) ? ["", target.source === "manual"
      ? "Action required: report the failing check(s)/merge conflict(s) above and wait for authorization before making changes."
      : "Action required: resolve the failing check(s)/merge conflict(s) on HEAD before continuing. If you can't, explain why."] : []),
    ...(live.some((item) => item.reviewAction) ? ["", target.source === "manual"
      ? "Review action required: report the requested changes and wait for authorization before making changes."
      : "Review action required: assess the requested changes, address actionable feedback, and explain anything you decline or cannot resolve."] : []),
    ...(live.some((item) => item.unverified) ? ["", "Verify current status before acting on UNVERIFIED history; it is not a confirmed current blocker."] : []),
    "", "Incorporate only the above into your reasoning and continue.", "</system-reminder>",
  ].join("\n")
  return { reminderText, events: [...condensedLive, ...supersededSummaries] }
}

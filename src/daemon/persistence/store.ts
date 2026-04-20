import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { PREMIND_CLIENT_LEASE_TTL_MS, PREMIND_DB_PATH, PREMIND_STATE_DIR } from "../../shared/constants.ts"
import type {
  AckReminderPayload,
  ClientMetadata,
  RegisterSessionPayload,
  ReminderBatch,
  ReminderEvent,
  UpdateSessionStatePayload,
} from "../../shared/schema.ts"
import type { NormalizedPrEvent, PullRequestSnapshot } from "../github/types.ts"
import { DetailFileWriter } from "../reminders/detail-files.ts"

type SessionRow = {
  session_id: string
  client_id: string
  repo: string
  branch: string
  pr_number: number | null
  is_primary: number
  status: "active" | "paused" | "closed"
  busy_state: "busy" | "idle"
  last_delivered_event_seq: number
  last_activity_at: number
}

type ReminderRow = {
  batch_id: string
  session_id: string
  reminder_text: string
  events_json: string
  state: "built" | "handed_off" | "confirmed" | "failed"
  max_event_seq: number | null
}

type EventRow = {
  seq: number
  kind: string
  priority: "high" | "medium" | "low"
  summary: string
  detail_file_path: string | null
}

type GroupedReminderEvent = ReminderEvent & {
  count?: number
  samples?: string[]
}

const priorityRank: Record<ReminderEvent["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

export class StateStore {
  private readonly db: DatabaseSync
  private readonly detailFiles = new DetailFileWriter()
  private lastReapAt: number | null = null
  private lastReapCount = 0

  constructor(dbPath = PREMIND_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  close() {
    this.db.close()
  }

  registerClient(clientId: string, metadata: ClientMetadata, now = Date.now()) {
    const expiresAt = now + PREMIND_CLIENT_LEASE_TTL_MS
    this.db
      .prepare(
        `
          INSERT INTO client_leases (client_id, pid, project_root, session_source, expires_at, created_at, updated_at)
          VALUES (:clientId, :pid, :projectRoot, :sessionSource, :expiresAt, :now, :now)
          ON CONFLICT(client_id) DO UPDATE SET
            pid = excluded.pid,
            project_root = excluded.project_root,
            session_source = excluded.session_source,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        clientId,
        pid: metadata.pid,
        projectRoot: metadata.projectRoot,
        sessionSource: metadata.sessionSource ?? null,
        expiresAt,
        now,
      })
  }

  recoverFromRestart(now = Date.now()) {
    // Prune all client leases — previous daemon process is dead,
    // so all leases from it are stale regardless of expiry.
    const deletedClients = this.db.prepare(`DELETE FROM client_leases`).run()

    // Clear any in-flight reminder batches that were handed_off but never confirmed.
    // They'll be rebuilt from the event log on next idle.
    const resetBatches = this.db.prepare(`DELETE FROM reminder_batches WHERE state = 'handed_off'`).run()

    // Count what we're recovering.
    const sessions = this.countActiveSessions()
    const branchWatchers = (this.db.prepare(`SELECT COUNT(*) AS count FROM branch_watchers WHERE active_session_count > 0`).get() as { count: number }).count
    const prWatchers = this.countActiveWatchers()

    return {
      prunedClients: deletedClients.changes as number,
      resetBatches: resetBatches.changes as number,
      recoveredSessions: sessions,
      recoveredBranchWatchers: branchWatchers,
      recoveredPrWatchers: prWatchers,
    }
  }

  heartbeatClient(clientId: string, now = Date.now()) {
    const result = this.db
      .prepare(`UPDATE client_leases SET expires_at = :expiresAt, updated_at = :now WHERE client_id = :clientId`)
      .run({ clientId, expiresAt: now + PREMIND_CLIENT_LEASE_TTL_MS, now })
    return (result.changes as number) > 0
  }

  releaseClient(clientId: string) {
    this.db.prepare(`DELETE FROM client_leases WHERE client_id = ?`).run(clientId)
  }

  pruneExpiredClients(now = Date.now()) {
    this.db.prepare(`DELETE FROM client_leases WHERE expires_at <= ?`).run(now)
  }

  registerSession(payload: RegisterSessionPayload, now = Date.now()): { created: boolean } {
    const existing = this.getSession(payload.sessionId)
    this.db
      .prepare(
        `
          INSERT INTO sessions (session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
          VALUES (:sessionId, :clientId, :repo, :branch, NULL, :isPrimary, :status, :busyState, 0, :now, :now, :now)
          ON CONFLICT(session_id) DO UPDATE SET
            client_id = excluded.client_id,
            repo = excluded.repo,
            branch = excluded.branch,
            is_primary = excluded.is_primary,
            status = excluded.status,
            busy_state = excluded.busy_state,
            last_activity_at = excluded.last_activity_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        ...payload,
        isPrimary: payload.isPrimary ? 1 : 0,
        now,
      })
    this.touchBranchWatcher(payload.repo, payload.branch, now)
    return { created: !existing }
  }

  updateSessionState(payload: UpdateSessionStatePayload, now = Date.now()) {
    const current = this.getSession(payload.sessionId)
    if (!current) return false
    const next = {
      repo: payload.repo ?? current.repo,
      branch: payload.branch ?? current.branch,
      status: payload.status ?? current.status,
      busyState: payload.busyState ?? current.busy_state,
    }

    this.db
      .prepare(
        `
          UPDATE sessions
          SET repo = :repo,
              branch = :branch,
              status = :status,
              busy_state = :busyState,
              last_activity_at = :now,
              updated_at = :now
          WHERE session_id = :sessionId
        `,
      )
      .run({
        sessionId: payload.sessionId,
        ...next,
        now,
      })

    this.touchBranchWatcher(next.repo, next.branch, now)
    return true
  }

  unregisterSession(sessionId: string) {
    this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId)
    this.db.prepare(`DELETE FROM reminder_batches WHERE session_id = ?`).run(sessionId)
  }

  /**
   * Marks any non-closed session whose last_activity_at is older than the
   * threshold as "closed". Also refreshes watcher counts when any rows were
   * reaped so the next poll tick reflects reality.
   *
   * Records lastReapAt/lastReapCount on every call (including no-op sweeps)
   * so operators can verify the sweep is actually running.
   */
  reapStaleSessions(thresholdMs: number, now = Date.now()): { reaped: number; oldestAgeMs: number | null } {
    const cutoff = now - thresholdMs
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'closed', updated_at = :now WHERE status != 'closed' AND last_activity_at < :cutoff`,
      )
      .run({ now, cutoff })

    const reaped = result.changes as number
    if (reaped > 0) this.refreshWatcherCounts(now)

    const oldestRow = this.db
      .prepare(`SELECT MIN(last_activity_at) AS oldest FROM sessions WHERE status != 'closed'`)
      .get() as { oldest: number | null }
    const oldestAgeMs = oldestRow.oldest === null ? null : now - oldestRow.oldest

    this.lastReapAt = now
    this.lastReapCount = reaped

    return { reaped, oldestAgeMs }
  }

  getLastReapAt(): number | null {
    return this.lastReapAt
  }

  getLastReapCount(): number {
    return this.lastReapCount
  }

  getSession(sessionId: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRow | undefined
  }

  listSessionSummaries() {
    const sessions = this.db
      .prepare(`SELECT session_id, repo, branch, pr_number, status, busy_state, last_delivered_event_seq FROM sessions ORDER BY updated_at DESC`)
      .all() as Array<{
      session_id: string
      repo: string
      branch: string
      pr_number: number | null
      status: "active" | "paused" | "closed"
      busy_state: "busy" | "idle"
      last_delivered_event_seq: number
    }>

    return sessions.map((session) => {
      const pendingReminderCount = session.pr_number === null
        ? 0
        : (this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM pr_events WHERE repo = :repo AND pr_number = :prNumber AND seq > :lastDeliveredEventSeq`,
            )
            .get({
              repo: session.repo,
              prNumber: session.pr_number,
              lastDeliveredEventSeq: session.last_delivered_event_seq,
            }) as { count: number }).count

      return {
        sessionId: session.session_id,
        repo: session.repo,
        branch: session.branch,
        prNumber: session.pr_number,
        status: session.status,
        busyState: session.busy_state,
        pendingReminderCount,
      }
    })
  }

  setSessionPaused(sessionId: string, paused: boolean, now = Date.now()) {
    const status = paused ? "paused" : "active"
    const result = this.db
      .prepare(`UPDATE sessions SET status = :status, updated_at = :now WHERE session_id = :sessionId`)
      .run({ status, now, sessionId })
    return (result.changes as number) > 0
  }

  isGloballyDisabled(): boolean {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'globally_disabled'`)
      .get() as { value: string } | undefined
    return row?.value === "true"
  }

  setGloballyDisabled(disabled: boolean, now = Date.now()) {
    this.db
      .prepare(
        `
          INSERT INTO settings (key, value, updated_at)
          VALUES ('globally_disabled', :value, :now)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run({ value: disabled ? "true" : "false", now })
  }

  countActiveClients(now = Date.now()) {
    this.pruneExpiredClients(now)
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM client_leases`).get() as { count: number }
    return row.count
  }

  countActiveSessions() {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status != 'closed'`).get() as { count: number }
    return row.count
  }

  countActiveWatchers() {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM pr_watchers WHERE active_session_count > 0`)
      .get() as { count: number }
    return row.count
  }

  listBranchWatchTargets(now = Date.now()) {
    this.pruneExpiredClients(now)
    this.refreshWatcherCounts(now)
    return this.db
      .prepare(
        `
          SELECT repo, branch, pr_number, last_checked_at, active_session_count
          FROM branch_watchers
          WHERE active_session_count > 0
          ORDER BY updated_at ASC
        `,
      )
      .all() as Array<{
      repo: string
      branch: string
      pr_number: number | null
      last_checked_at: number | null
      active_session_count: number
    }>
  }

  recordBranchAssociation(repo: string, branch: string, prNumber: number | null, checkedAt = Date.now()) {
    this.db
      .prepare(
        `
          INSERT INTO branch_watchers (repo, branch, pr_number, last_checked_at, active_session_count, created_at, updated_at)
          VALUES (:repo, :branch, :prNumber, :checkedAt, 0, :checkedAt, :checkedAt)
          ON CONFLICT(repo, branch) DO UPDATE SET
            pr_number = excluded.pr_number,
            last_checked_at = excluded.last_checked_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({ repo, branch, prNumber, checkedAt })

    // Find sessions whose pr_number is about to change. For any session that is newly
    // associated with a PR (or switched to a different PR), fast-forward its delivery
    // cursor past any pre-existing events for that PR. This prevents replaying history
    // the user has either already seen (re-attach case) or never saw but wouldn't want
    // dumped at once (stale event log).
    const sessionsToUpdate = this.db
      .prepare(
        `SELECT session_id, pr_number FROM sessions WHERE repo = :repo AND branch = :branch`,
      )
      .all({ repo, branch }) as Array<{ session_id: string; pr_number: number | null }>

    let freshCursor = 0
    if (prNumber !== null) {
      const row = this.db
        .prepare(`SELECT MAX(seq) AS maxSeq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`)
        .get({ repo, prNumber }) as { maxSeq: number | null } | undefined
      freshCursor = row?.maxSeq ?? 0
    }

    this.db
      .prepare(`UPDATE sessions SET pr_number = :prNumber, updated_at = :checkedAt WHERE repo = :repo AND branch = :branch`)
      .run({ repo, branch, prNumber, checkedAt })

    if (prNumber !== null && freshCursor > 0) {
      const advance = this.db.prepare(
        `UPDATE sessions SET last_delivered_event_seq = :cursor WHERE session_id = :sessionId`,
      )
      for (const session of sessionsToUpdate) {
        if (session.pr_number !== prNumber) {
          advance.run({ cursor: freshCursor, sessionId: session.session_id })
        }
      }
    }

    if (prNumber !== null) {
      this.touchPrWatcher(repo, prNumber, checkedAt)
    }
  }

  getSnapshot(repo: string, prNumber: number) {
    const row = this.db
      .prepare(`SELECT snapshot_json FROM pr_snapshots WHERE repo = ? AND pr_number = ?`)
      .get(repo, prNumber) as { snapshot_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.snapshot_json) as PullRequestSnapshot
  }

  /**
   * ETag cache for conditional GitHub requests. `scope` is a short tag
   * (e.g. "pr.snapshot", "branch.pulls"); `key` uniquely identifies the
   * resource within that scope (e.g. `${repo}#${prNumber}`).
   */
  getEtag(scope: string, key: string): string | null {
    const row = this.db
      .prepare(`SELECT etag FROM etags WHERE scope = ? AND key = ?`)
      .get(scope, key) as { etag: string } | undefined
    return row?.etag ?? null
  }

  saveEtag(scope: string, key: string, etag: string | null, now = Date.now()) {
    if (etag === null) {
      this.db.prepare(`DELETE FROM etags WHERE scope = ? AND key = ?`).run(scope, key)
      return
    }
    this.db
      .prepare(
        `
          INSERT INTO etags (scope, key, etag, updated_at)
          VALUES (:scope, :key, :etag, :now)
          ON CONFLICT(scope, key) DO UPDATE SET
            etag = excluded.etag,
            updated_at = excluded.updated_at
        `,
      )
      .run({ scope, key, etag, now })
  }

  saveSnapshot(repo: string, prNumber: number, snapshot: PullRequestSnapshot) {
    this.db
      .prepare(
        `
          INSERT INTO pr_snapshots (repo, pr_number, head_sha, snapshot_json, fetched_at, updated_at)
          VALUES (:repo, :prNumber, :headSha, :snapshotJson, :fetchedAt, :fetchedAt)
          ON CONFLICT(repo, pr_number) DO UPDATE SET
            head_sha = excluded.head_sha,
            snapshot_json = excluded.snapshot_json,
            fetched_at = excluded.fetched_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        repo,
        prNumber,
        headSha: snapshot.core.headRefOid,
        snapshotJson: JSON.stringify(snapshot),
        fetchedAt: snapshot.fetchedAt,
      })
  }

  insertEvents(repo: string, prNumber: number, events: NormalizedPrEvent[], now = Date.now()) {
    const insert = this.db.prepare(
      `
        INSERT OR IGNORE INTO pr_events (repo, pr_number, dedupe_key, kind, priority, summary, detail_file_path, payload_json, created_at)
        VALUES (:repo, :prNumber, :dedupeKey, :kind, :priority, :summary, :detailFilePath, :payloadJson, :now)
      `,
    )

    this.db.exec("BEGIN")
    try {
      for (const event of events) {
        const detailFilePath = this.detailFiles.write(repo, prNumber, event)
        insert.run({
          repo,
          prNumber,
          dedupeKey: event.dedupeKey,
          kind: event.kind,
          priority: event.priority,
          summary: event.summary,
          detailFilePath,
          payloadJson: JSON.stringify(event.payload),
          now,
        })
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  listPrWatchTargets(now = Date.now()) {
    this.pruneExpiredClients(now)
    this.refreshWatcherCounts(now)
    return this.db
      .prepare(
        `
          SELECT repo, pr_number, active_session_count, last_checked_at
          FROM pr_watchers
          WHERE active_session_count > 0 AND pr_number IS NOT NULL
          ORDER BY updated_at ASC
        `,
      )
      .all() as Array<{ repo: string; pr_number: number; active_session_count: number; last_checked_at: number | null }>
  }

  markPrWatchChecked(repo: string, prNumber: number, checkedAt = Date.now()) {
    this.db
      .prepare(`UPDATE pr_watchers SET last_checked_at = :checkedAt, updated_at = :checkedAt WHERE repo = :repo AND pr_number = :prNumber`)
      .run({ repo, prNumber, checkedAt })
  }

  listSessionsForPr(repo: string, prNumber: number) {
    return this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE repo = :repo AND pr_number = :prNumber AND status != 'closed'
        `,
      )
      .all({ repo, prNumber }) as SessionRow[]
  }

  listUndeliveredEvents(sessionId: string, limit = 20) {
    const session = this.getSession(sessionId)
    if (!session || session.pr_number === null) return []
    return this.db
      .prepare(
        `
          SELECT seq, kind, priority, summary, detail_file_path
          FROM pr_events
          WHERE repo = :repo
            AND pr_number = :prNumber
            AND seq > :lastDeliveredEventSeq
          ORDER BY seq ASC
          LIMIT :limit
        `,
      )
      .all({
        repo: session.repo,
        prNumber: session.pr_number,
        lastDeliveredEventSeq: (session as SessionRow & { last_delivered_event_seq?: number }).last_delivered_event_seq ?? 0,
        limit,
      }) as EventRow[]
  }

  createOrReplaceReminder(sessionId: string, reminderText: string, events: ReminderEvent[], now = Date.now()) {
    const batchId = randomUUID()
    const maxEventSeq = this.listUndeliveredEvents(sessionId).at(-1)?.seq ?? null
    this.db
      .prepare(
        `
          INSERT INTO reminder_batches (batch_id, session_id, reminder_text, events_json, state, max_event_seq, created_at, updated_at)
          VALUES (:batchId, :sessionId, :reminderText, :eventsJson, 'built', :maxEventSeq, :now, :now)
          ON CONFLICT(session_id) DO UPDATE SET
            batch_id = excluded.batch_id,
            reminder_text = excluded.reminder_text,
            events_json = excluded.events_json,
            state = excluded.state,
            max_event_seq = excluded.max_event_seq,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        batchId,
        sessionId,
        reminderText,
        eventsJson: JSON.stringify(events),
        maxEventSeq,
        now,
      })

    return batchId
  }

  getPendingReminder(sessionId: string): ReminderBatch | null {
    const row = this.db
      .prepare(`SELECT batch_id, session_id, reminder_text, events_json, state FROM reminder_batches WHERE session_id = ?`)
      .get(sessionId) as ReminderRow | undefined
    if (!row || row.state === "confirmed") return null
    return {
      batchId: row.batch_id,
      sessionId: row.session_id,
      reminderText: row.reminder_text,
      events: JSON.parse(row.events_json) as ReminderEvent[],
    }
  }

  ackReminder(payload: AckReminderPayload, now = Date.now()) {
    const current = this.db
      .prepare(`SELECT batch_id FROM reminder_batches WHERE session_id = ?`)
      .get(payload.sessionId) as { batch_id: string } | undefined
    if (!current || current.batch_id !== payload.batchId) return false

    if (payload.state === "confirmed") {
      const row = this.db
        .prepare(`SELECT max_event_seq FROM reminder_batches WHERE session_id = ?`)
        .get(payload.sessionId) as { max_event_seq: number | null } | undefined
      if (row?.max_event_seq !== null && row?.max_event_seq !== undefined) {
        this.db
          .prepare(`UPDATE sessions SET last_delivered_event_seq = :seq, updated_at = :now WHERE session_id = :sessionId`)
          .run({ seq: row.max_event_seq, now, sessionId: payload.sessionId })
      }
      this.db.prepare(`DELETE FROM reminder_batches WHERE session_id = ?`).run(payload.sessionId)
      return true
    }

    this.db
      .prepare(`UPDATE reminder_batches SET state = :state, updated_at = :now WHERE session_id = :sessionId`)
      .run({ state: payload.state, now, sessionId: payload.sessionId })
    return true
  }

  listSessionsForBranch(repo: string, branch: string) {
    return this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE repo = :repo AND branch = :branch AND status != 'closed'
        `,
      )
      .all({ repo, branch }) as SessionRow[]
  }

  buildReminderBatch(sessionId: string, now = Date.now()): ReminderBatch | null {
    const session = this.getSession(sessionId)
    if (!session || session.status === "paused" || session.status === "closed") return null

    const existing = this.getPendingReminder(sessionId)
    if (existing) return existing

    const events = this.listUndeliveredEvents(sessionId)
    if (events.length === 0) return null

    const reminderEvents: GroupedReminderEvent[] = events.map((event) => ({
      eventId: String(event.seq),
      kind: event.kind,
      priority: event.priority,
      summary: event.summary,
      detailFilePath: event.detail_file_path ?? undefined,
    }))

    const grouped = new Map<string, GroupedReminderEvent[]>()
    for (const event of reminderEvents) {
      const key = event.priority === "low" || event.priority === "medium" ? `${event.priority}:${event.kind}` : event.eventId
      const bucket = grouped.get(key)
      if (bucket) bucket.push(event)
      else grouped.set(key, [event])
    }

    const condensed = Array.from(grouped.values()).map((bucket) => {
      if (bucket.length === 1 || bucket[0].priority === "high") return bucket[0]
      return {
        ...bucket[0],
        summary: `${bucket.length} ${bucket[0].kind.replaceAll("_", " ")} events (${bucket
          .slice(0, 2)
          .map((event) => event.summary)
          .join("; ")})`,
        count: bucket.length,
        samples: bucket.slice(0, 2).map((event) => event.summary),
      }
    })

    condensed.sort((left, right) => {
      const priorityDelta = priorityRank[left.priority] - priorityRank[right.priority]
      if (priorityDelta !== 0) return priorityDelta
      return Number(left.eventId) - Number(right.eventId)
    })

    const reminderText = [
      "<system-reminder>",
      "New pull request context was detected since the last reminder.",
      "",
      "Changes:",
      ...condensed.map((event, index) => `${index + 1}. ${event.kind} - ${event.summary}${event.detailFilePath ? ` (${event.detailFilePath})` : ""}`),
      "",
      "Please incorporate only the new information above into your reasoning and continue the current task.",
      "</system-reminder>",
    ].join("\n")

    const batchId = this.createOrReplaceReminder(sessionId, reminderText, condensed, now)
    return {
      batchId,
      sessionId,
      reminderText,
      events: condensed,
    }
  }

  private touchBranchWatcher(repo: string, branch: string, now = Date.now()) {
    this.db
      .prepare(
        `
          INSERT INTO branch_watchers (repo, branch, pr_number, last_checked_at, active_session_count, created_at, updated_at)
          VALUES (:repo, :branch, NULL, NULL, 0, :now, :now)
          ON CONFLICT(repo, branch) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
      )
      .run({ repo, branch, now })
    this.refreshWatcherCounts(now)
  }

  private touchPrWatcher(repo: string, prNumber: number, now = Date.now()) {
    this.db
      .prepare(
        `
          INSERT INTO pr_watchers (repo, pr_number, last_checked_at, active_session_count, created_at, updated_at)
          VALUES (:repo, :prNumber, NULL, 0, :now, :now)
          ON CONFLICT(repo, pr_number) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
      )
      .run({ repo, prNumber, now })
    this.refreshWatcherCounts(now)
  }

  private refreshWatcherCounts(now = Date.now()) {
    this.db.prepare(`UPDATE branch_watchers SET active_session_count = 0, updated_at = :now`).run({ now })
    this.db
      .prepare(
        `
          UPDATE branch_watchers
          SET active_session_count = (
            SELECT COUNT(*)
            FROM sessions
            WHERE sessions.repo = branch_watchers.repo
              AND sessions.branch = branch_watchers.branch
              AND sessions.status != 'closed'
          ),
              updated_at = :now
        `,
      )
      .run({ now })

    this.db.prepare(`UPDATE pr_watchers SET active_session_count = 0, updated_at = :now`).run({ now })
    this.db
      .prepare(
        `
          UPDATE pr_watchers
          SET active_session_count = (
            SELECT COUNT(*)
            FROM sessions
            WHERE sessions.repo = pr_watchers.repo
              AND sessions.pr_number = pr_watchers.pr_number
              AND sessions.status != 'closed'
          ),
              updated_at = :now
        `,
      )
      .run({ now })
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_leases (
        client_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        project_root TEXT NOT NULL,
        session_source TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        is_primary INTEGER NOT NULL,
        status TEXT NOT NULL,
        busy_state TEXT NOT NULL,
        last_delivered_event_seq INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminder_batches (
        session_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        reminder_text TEXT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        max_event_seq INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS branch_watchers (
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        last_checked_at INTEGER,
        active_session_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repo, branch)
      );

      CREATE TABLE IF NOT EXISTS pr_watchers (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        last_checked_at INTEGER,
        active_session_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repo, pr_number)
      );

      CREATE TABLE IF NOT EXISTS pr_snapshots (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repo, pr_number)
      );

      CREATE TABLE IF NOT EXISTS pr_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        priority TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail_file_path TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS etags (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        etag TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, key)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    const sessionColumns = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>
    if (!sessionColumns.some((column) => column.name === "last_delivered_event_seq")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_delivered_event_seq INTEGER NOT NULL DEFAULT 0`)
    }

    const reminderColumns = this.db.prepare(`PRAGMA table_info(reminder_batches)`).all() as Array<{ name: string }>
    if (!reminderColumns.some((column) => column.name === "max_event_seq")) {
      this.db.exec(`ALTER TABLE reminder_batches ADD COLUMN max_event_seq INTEGER`)
    }
  }
}

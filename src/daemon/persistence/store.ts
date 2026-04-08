import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { randomUUID } from "node:crypto"
import { PREMIND_CLIENT_LEASE_TTL_MS, PREMIND_DB_PATH, PREMIND_STATE_DIR } from "../../shared/constants.js"
import type {
  AckReminderPayload,
  ClientMetadata,
  RegisterSessionPayload,
  ReminderBatch,
  ReminderEvent,
  UpdateSessionStatePayload,
} from "../../shared/schema.js"
import type { NormalizedPrEvent, PullRequestSnapshot } from "../github/types.js"
import { DetailFileWriter } from "../reminders/detail-files.js"

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
  private readonly db: Database.Database
  private readonly detailFiles = new DetailFileWriter()

  constructor(dbPath = PREMIND_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
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
          VALUES (@clientId, @pid, @projectRoot, @sessionSource, @expiresAt, @now, @now)
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

  heartbeatClient(clientId: string, now = Date.now()) {
    const result = this.db
      .prepare(`UPDATE client_leases SET expires_at = @expiresAt, updated_at = @now WHERE client_id = @clientId`)
      .run({ clientId, expiresAt: now + PREMIND_CLIENT_LEASE_TTL_MS, now })
    return result.changes > 0
  }

  releaseClient(clientId: string) {
    this.db.prepare(`DELETE FROM client_leases WHERE client_id = ?`).run(clientId)
  }

  pruneExpiredClients(now = Date.now()) {
    this.db.prepare(`DELETE FROM client_leases WHERE expires_at <= ?`).run(now)
  }

  registerSession(payload: RegisterSessionPayload, now = Date.now()) {
    this.db
      .prepare(
        `
          INSERT INTO sessions (session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, created_at, updated_at)
          VALUES (@sessionId, @clientId, @repo, @branch, NULL, @isPrimary, @status, @busyState, 0, @now, @now)
          ON CONFLICT(session_id) DO UPDATE SET
            client_id = excluded.client_id,
            repo = excluded.repo,
            branch = excluded.branch,
            is_primary = excluded.is_primary,
            status = excluded.status,
            busy_state = excluded.busy_state,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        ...payload,
        isPrimary: payload.isPrimary ? 1 : 0,
        now,
      })
    this.touchBranchWatcher(payload.repo, payload.branch, now)
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
          SET repo = @repo,
              branch = @branch,
              status = @status,
              busy_state = @busyState,
              updated_at = @now
          WHERE session_id = @sessionId
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

  getSession(sessionId: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRow | undefined
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
          VALUES (@repo, @branch, @prNumber, @checkedAt, 0, @checkedAt, @checkedAt)
          ON CONFLICT(repo, branch) DO UPDATE SET
            pr_number = excluded.pr_number,
            last_checked_at = excluded.last_checked_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({ repo, branch, prNumber, checkedAt })

    this.db
      .prepare(`UPDATE sessions SET pr_number = @prNumber, updated_at = @checkedAt WHERE repo = @repo AND branch = @branch`)
      .run({ repo, branch, prNumber, checkedAt })

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

  saveSnapshot(repo: string, prNumber: number, snapshot: PullRequestSnapshot) {
    this.db
      .prepare(
        `
          INSERT INTO pr_snapshots (repo, pr_number, head_sha, snapshot_json, fetched_at, updated_at)
          VALUES (@repo, @prNumber, @headSha, @snapshotJson, @fetchedAt, @fetchedAt)
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
        VALUES (@repo, @prNumber, @dedupeKey, @kind, @priority, @summary, @detailFilePath, @payloadJson, @now)
      `,
    )

    const transaction = this.db.transaction((items: NormalizedPrEvent[]) => {
      for (const event of items) {
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
    })

    transaction(events)
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
      .prepare(`UPDATE pr_watchers SET last_checked_at = @checkedAt, updated_at = @checkedAt WHERE repo = @repo AND pr_number = @prNumber`)
      .run({ repo, prNumber, checkedAt })
  }

  listSessionsForPr(repo: string, prNumber: number) {
    return this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE repo = @repo AND pr_number = @prNumber AND status != 'closed'
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
          WHERE repo = @repo
            AND pr_number = @prNumber
            AND seq > @lastDeliveredEventSeq
          ORDER BY seq ASC
          LIMIT @limit
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
          VALUES (@batchId, @sessionId, @reminderText, @eventsJson, 'built', @maxEventSeq, @now, @now)
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
          .prepare(`UPDATE sessions SET last_delivered_event_seq = @seq, updated_at = @now WHERE session_id = @sessionId`)
          .run({ seq: row.max_event_seq, now, sessionId: payload.sessionId })
      }
      this.db.prepare(`DELETE FROM reminder_batches WHERE session_id = ?`).run(payload.sessionId)
      return true
    }

    this.db
      .prepare(`UPDATE reminder_batches SET state = @state, updated_at = @now WHERE session_id = @sessionId`)
      .run({ state: payload.state, now, sessionId: payload.sessionId })
    return true
  }

  listSessionsForBranch(repo: string, branch: string) {
    return this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE repo = @repo AND branch = @branch AND status != 'closed'
        `,
      )
      .all({ repo, branch }) as SessionRow[]
  }

  buildReminderBatch(sessionId: string, now = Date.now()): ReminderBatch | null {
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
          VALUES (@repo, @branch, NULL, NULL, 0, @now, @now)
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
          VALUES (@repo, @prNumber, NULL, 0, @now, @now)
          ON CONFLICT(repo, pr_number) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
      )
      .run({ repo, prNumber, now })
    this.refreshWatcherCounts(now)
  }

  private refreshWatcherCounts(now = Date.now()) {
    this.db.prepare(`UPDATE branch_watchers SET active_session_count = 0, updated_at = @now`).run({ now })
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
              updated_at = @now
        `,
      )
      .run({ now })

    this.db.prepare(`UPDATE pr_watchers SET active_session_count = 0, updated_at = @now`).run({ now })
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
              updated_at = @now
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

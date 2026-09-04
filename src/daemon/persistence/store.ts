import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
	PREMIND_CLIENT_LEASE_TTL_MS,
	PREMIND_DB_PATH,
	PREMIND_PR_STREAM_RETENTION_MS,
	PREMIND_STATE_DIR,
	PREMIND_SUBSCRIPTION_RETENTION_MS,
} from "../../shared/constants.ts";
import type {
	AckReminderPayload,
	ClientMetadata,
	EnsureSessionControlPayload,
	RegisterSessionPayload,
	ReminderBatch,
	ReminderEvent,
	UpdateSessionStatePayload,
} from "../../shared/schema.ts";
import type {
	NormalizedPrEvent,
	PullRequestSnapshot,
} from "../github/types.ts";
import { DetailFileWriter } from "../reminders/detail-files.ts";
import { createReminderHandoffActor, eventForReminderState, type ReminderHandoffState } from "../reminders/reminder-handoff-machine.ts";
import type { PrWatcherState } from "../watchers/pr-watcher-machine.ts";

type SessionRow = {
	session_id: string;
	client_id: string;
	repo: string;
	branch: string;
	pr_number: number | null;
	is_primary: number;
	status: "active" | "paused" | "closed";
	busy_state: "busy" | "idle";
	last_delivered_event_seq: number;
	last_activity_at: number;
};

export type SubscriptionSource = "automatic" | "manual";
export type SubscriptionState = "active" | "unsubscribed";

export type PrWatcherRecord = {
	repo: string;
	prNumber: number;
	state: PrWatcherState;
	activeSubscriberCount: number;
	lastCheckedAt: number | null;
	idleDeadlineAt: number | null;
	terminalAt: number | null;
	nextEligiblePollAt: number | null;
	consecutiveFailures: number;
	lastFailureAt: number | null;
	lastFailureMessage: string | null;
	rateLimitResetAt: number | null;
	createdAt: number;
	updatedAt: number;
};

export type PrStreamPruneResult = {
	events: number;
	snapshots: number;
	watchers: number;
	subscriptions: number;
};

export type WorktreeBinding = {
	sessionId: string;
	root: string;
	gitDir: string;
	repo: string;
	branch: string | null;
	headSha: string;
	state: string;
	updatedAt: number;
};

export type SessionSubscription = {
	subscriptionId: string;
	sessionId: string;
	repo: string;
	prNumber: number;
	source: SubscriptionSource;
	state: SubscriptionState;
	lastDeliveredEventSeq: number;
	updatedAt: number;
};

type ReminderRow = {
	batch_id: string;
	session_id: string;
	subscription_id: string | null;
	reminder_text: string;
	events_json: string;
	state: ReminderHandoffState;
	max_event_seq: number | null;
	repo?: string | null;
	pr_number?: number | null;
	source?: SubscriptionSource | null;
};

export type ReminderBatchRecord = Omit<ReminderBatch, "subscriptionId"> & {
	state: ReminderHandoffState;
	subscriptionId: string | null;
	maxEventSeq: number | null;
};

type EventRow = {
	seq: number;
	kind: string;
	priority: "high" | "medium" | "low";
	summary: string;
	reference_link: string | null;
};

type GroupedReminderEvent = ReminderEvent & {
	count?: number;
	samples?: string[];
};

const priorityRank: Record<ReminderEvent["priority"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

export class StateStore {
	private readonly db: DatabaseSync;
	private readonly detailFiles = new DetailFileWriter();
	private lastReapAt: number | null = null;
	private lastReapCount = 0;

	constructor(dbPath = PREMIND_DB_PATH) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close() {
		this.db.close();
	}

	transaction<T>(operation: () => T): T {
		// SQLite resolves duplicate savepoint names to the most recently opened one,
		// which makes this safe for nested store operations without dynamic SQL.
		this.db.exec("SAVEPOINT premind_transaction");
		try {
			const result = operation();
			this.db.exec("RELEASE premind_transaction");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK TO premind_transaction");
			this.db.exec("RELEASE premind_transaction");
			throw error;
		}
	}

	registerClient(clientId: string, metadata: ClientMetadata, now = Date.now()) {
		const expiresAt = now + PREMIND_CLIENT_LEASE_TTL_MS;
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
			});
	}

	recoverFromRestart(now = Date.now()) {
		// Prune all client leases — previous daemon process is dead,
		// so all leases from it are stale regardless of expiry.
		const deletedClients = this.db.prepare(`DELETE FROM client_leases`).run();

		// A crash leaves handed-off delivery uncertain. Preserve the durable batch
		// and its cursor, but move it through the valid failure transition so the
		// handoff registry can explicitly retry it after reconstruction.
		const resetBatches = this.db
			.prepare(
				`UPDATE reminder_batches SET state = 'failed', updated_at = :now
				 WHERE state = 'handed_off'`,
			)
			.run({ now });

		// Count what we're recovering.
		const sessions = this.countActiveSessions();
		const branchWatchers = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM branch_watchers WHERE active_session_count > 0`,
				)
				.get() as { count: number }
		).count;
		const prWatchers = this.countActiveWatchers();

		return {
			prunedClients: deletedClients.changes as number,
			resetBatches: resetBatches.changes as number,
			// Retained for protocol compatibility. Same-branch sessions are independent consumers.
			dedupedSessions: 0,
			recoveredSessions: sessions,
			recoveredBranchWatchers: branchWatchers,
			recoveredPrWatchers: prWatchers,
		};
	}

	heartbeatClient(clientId: string, now = Date.now()) {
		const result = this.db
			.prepare(
				`UPDATE client_leases SET expires_at = :expiresAt, updated_at = :now WHERE client_id = :clientId`,
			)
			.run({ clientId, expiresAt: now + PREMIND_CLIENT_LEASE_TTL_MS, now });
		return (result.changes as number) > 0;
	}

	hasActiveClient(clientId: string, now = Date.now()) {
		this.pruneExpiredClients(now);
		return this.db.prepare(`SELECT 1 FROM client_leases WHERE client_id = ?`).get(clientId) !== undefined;
	}

	releaseClient(clientId: string) {
		this.db
			.prepare(`DELETE FROM client_leases WHERE client_id = ?`)
			.run(clientId);
	}

	pruneExpiredClients(now = Date.now()) {
		this.db.prepare(`DELETE FROM client_leases WHERE expires_at <= ?`).run(now);
	}

	registerSession(
		payload: RegisterSessionPayload,
		now = Date.now(),
	): { created: boolean; superseded: number } {
		return this.transaction(() => {
			const existing = this.getSession(payload.sessionId);
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
				});
			this.touchBranchWatcher(payload.repo, payload.branch, now);
			return { created: !existing, superseded: 0 };
		});
	}

	/**
	 * Atomically attaches a live client session and applies its paused state.
	 * Existing sessions retain their delivery cursor; recreated sessions begin at
	 * the branch's current PR-event high-water mark to avoid replaying history.
	 */
	ensureSessionControl(
		payload: EnsureSessionControlPayload,
		now = Date.now(),
	): { created: boolean; superseded: number } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.getSession(payload.sessionId);
			const status = payload.paused ? "paused" : "active";
			const contextChanged =
				existing !== undefined &&
				(existing.repo !== payload.repo || existing.branch !== payload.branch);
			const watcher = this.db
				.prepare(
					`SELECT pr_number FROM branch_watchers WHERE repo = :repo AND branch = :branch`,
				)
				.get({ repo: payload.repo, branch: payload.branch }) as {
				pr_number: number | null;
			} | undefined;
			const attachedPrNumber = watcher?.pr_number ?? null;
			const highWaterCursor =
				attachedPrNumber === null
					? 0
					: ((this.db
							.prepare(
								`SELECT MAX(seq) AS maxSeq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`,
							)
							.get({
								repo: payload.repo,
								prNumber: attachedPrNumber,
							}) as { maxSeq: number | null }).maxSeq ?? 0);
			const prNumber =
				existing && !contextChanged ? existing.pr_number : attachedPrNumber;
			const cursor =
				existing && !contextChanged
					? existing.last_delivered_event_seq
					: highWaterCursor;

			if (existing) {
				if (contextChanged) {
					// Reminder batches belong to the prior PR and must not cross branches.
					this.db
						.prepare(`DELETE FROM reminder_batches WHERE session_id = ?`)
						.run(payload.sessionId);
					this.deactivateAutomaticSubscriptions(payload.sessionId, now);
				}
				this.db
					.prepare(
						`UPDATE sessions
						 SET client_id = :clientId,
						     repo = :repo,
						     branch = :branch,
						     pr_number = :prNumber,
						     is_primary = :isPrimary,
						     status = :status,
						     busy_state = :busyState,
						     last_delivered_event_seq = :cursor,
						     last_activity_at = :now,
						     updated_at = :now
						 WHERE session_id = :sessionId`,
					)
					.run({
						clientId: payload.clientId,
						sessionId: payload.sessionId,
						repo: payload.repo,
						branch: payload.branch,
						prNumber,
						busyState: payload.busyState,
						isPrimary: payload.isPrimary ? 1 : 0,
						status,
						cursor,
						now,
					});
			} else {
				this.db
					.prepare(
						`INSERT INTO sessions (session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
						 VALUES (:sessionId, :clientId, :repo, :branch, :prNumber, :isPrimary, :status, :busyState, :cursor, :now, :now, :now)`,
					)
					.run({
						clientId: payload.clientId,
						sessionId: payload.sessionId,
						repo: payload.repo,
						branch: payload.branch,
						prNumber,
						busyState: payload.busyState,
						isPrimary: payload.isPrimary ? 1 : 0,
						status,
						cursor,
						now,
					});
			}

			this.touchBranchWatcher(payload.repo, payload.branch, now);
			this.db.exec("COMMIT");
			// Preserve the main-compatible response shape without closing peer sessions.
			return { created: !existing, superseded: 0 };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	updateSessionState(payload: UpdateSessionStatePayload, now = Date.now()) {
		const current = this.getSession(payload.sessionId);
		if (!current) return { updated: false, revived: false };
		const revived = current.status === "closed" && !!payload.busyState;
		const next = {
			repo: payload.repo ?? current.repo,
			branch: payload.branch ?? current.branch,
			busyState: payload.busyState ?? current.busy_state,
			// If a previously closed session becomes active again (for example via
			// `opencode --continue`), revive it so its independent delivery can resume.
			status: revived ? "active" : (payload.status ?? current.status),
		};

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
			});

		if (revived) this.refreshWatcherCounts(now);
		this.touchBranchWatcher(next.repo, next.branch, now);
		return { updated: true, revived };
	}

	unregisterSession(sessionId: string) {
		this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
		this.db
			.prepare(`DELETE FROM reminder_batches WHERE session_id = ?`)
			.run(sessionId);
	}

	upsertWorktreeBinding(
		binding: Omit<WorktreeBinding, "updatedAt">,
		now = Date.now(),
	): WorktreeBinding {
		if (!this.getSession(binding.sessionId)) {
			throw new Error(`Unknown session: ${binding.sessionId}`);
		}
		this.db
			.prepare(
				`
				INSERT INTO worktree_bindings (session_id, root, git_dir, repo, branch, head_sha, state, created_at, updated_at)
				VALUES (:sessionId, :root, :gitDir, :repo, :branch, :headSha, :state, :now, :now)
				ON CONFLICT(session_id) DO UPDATE SET
					root = excluded.root,
					git_dir = excluded.git_dir,
					repo = excluded.repo,
					branch = excluded.branch,
					head_sha = excluded.head_sha,
					state = excluded.state,
					updated_at = excluded.updated_at
				`,
			)
			.run({ ...binding, now });
		this.refreshWatcherCounts(now);
		return this.getWorktreeBinding(binding.sessionId)!;
	}

	getWorktreeBinding(sessionId: string): WorktreeBinding | null {
		const row = this.db
			.prepare(`SELECT * FROM worktree_bindings WHERE session_id = ?`)
			.get(sessionId) as {
				session_id: string;
				root: string;
				git_dir: string;
				repo: string;
				branch: string | null;
				head_sha: string;
				state: string;
				updated_at: number;
			} | undefined;
		if (!row) return null;
		return {
			sessionId: row.session_id,
			root: row.root,
			gitDir: row.git_dir,
			repo: row.repo,
			branch: row.branch,
			headSha: row.head_sha,
			state: row.state,
			updatedAt: row.updated_at,
		};
	}

	activateWorktree(
		binding: Omit<WorktreeBinding, "updatedAt">,
		now = Date.now(),
	): WorktreeBinding {
		return this.transaction(() => {
			const activeBinding = this.upsertWorktreeBinding(binding, now);
			this.deactivateAutomaticSubscriptions(binding.sessionId, now);
			if (binding.branch) this.ensureBranchWatcher(binding.repo, binding.branch, now);
			return activeBinding;
		});
	}

	upsertSubscription(
		input: { sessionId: string; repo: string; prNumber: number; source: SubscriptionSource },
		now = Date.now(),
	): SessionSubscription {
		return this.transaction(() => {
			if (!this.getSession(input.sessionId)) {
				throw new Error(`Unknown session: ${input.sessionId}`);
			}
			this.db
				.prepare(
					`
					INSERT INTO session_subscriptions (subscription_id, session_id, repo, pr_number, source, state, last_delivered_event_seq, created_at, updated_at)
					VALUES (:subscriptionId, :sessionId, :repo, :prNumber, :source, 'active', 0, :now, :now)
					ON CONFLICT(session_id, repo, pr_number) DO UPDATE SET
						source = CASE WHEN session_subscriptions.source = 'manual' OR excluded.source = 'manual' THEN 'manual' ELSE 'automatic' END,
						state = 'active',
						updated_at = excluded.updated_at
					`,
				)
				.run({ ...input, subscriptionId: randomUUID(), now });
			this.touchPrWatcher(input.repo, input.prNumber, now);
			return this.getSubscription(input.sessionId, input.repo, input.prNumber)!;
		});
	}

	getSubscription(sessionId: string, repo: string, prNumber: number): SessionSubscription | null {
		const row = this.db
			.prepare(`SELECT * FROM session_subscriptions WHERE session_id = ? AND repo = ? AND pr_number = ?`)
			.get(sessionId, repo, prNumber) as {
				subscription_id: string;
				session_id: string;
				repo: string;
				pr_number: number;
				source: SubscriptionSource;
				state: SubscriptionState;
				last_delivered_event_seq: number;
				updated_at: number;
			} | undefined;
		return row ? this.toSubscription(row) : null;
	}

	getSubscriptionById(subscriptionId: string): SessionSubscription | null {
		const row = this.db
			.prepare(`SELECT * FROM session_subscriptions WHERE subscription_id = ?`)
			.get(subscriptionId) as {
				subscription_id: string;
				session_id: string;
				repo: string;
				pr_number: number;
				source: SubscriptionSource;
				state: SubscriptionState;
				last_delivered_event_seq: number;
				updated_at: number;
			} | undefined;
		return row ? this.toSubscription(row) : null;
	}

	private toSubscription(row: {
		subscription_id: string;
		session_id: string;
		repo: string;
		pr_number: number;
		source: SubscriptionSource;
		state: SubscriptionState;
		last_delivered_event_seq: number;
		updated_at: number;
	}): SessionSubscription {
		return {
			subscriptionId: row.subscription_id,
			sessionId: row.session_id,
			repo: row.repo,
			prNumber: row.pr_number,
			source: row.source,
			state: row.state,
			lastDeliveredEventSeq: row.last_delivered_event_seq,
			updatedAt: row.updated_at,
		};
	}

	listSessionSubscriptions(sessionId: string, state?: SubscriptionState): SessionSubscription[] {
		const statement = state
			? this.db.prepare(`SELECT * FROM session_subscriptions WHERE session_id = :sessionId AND state = :state ORDER BY created_at ASC`)
			: this.db.prepare(`SELECT * FROM session_subscriptions WHERE session_id = :sessionId ORDER BY created_at ASC`);
		const rows = (state
			? statement.all({ sessionId, state })
			: statement.all({ sessionId })) as Array<{
			subscription_id: string; session_id: string; repo: string; pr_number: number; source: SubscriptionSource; state: SubscriptionState; last_delivered_event_seq: number; updated_at: number;
		}>;
		return rows.map((row) => ({
			subscriptionId: row.subscription_id, sessionId: row.session_id, repo: row.repo, prNumber: row.pr_number, source: row.source, state: row.state, lastDeliveredEventSeq: row.last_delivered_event_seq, updatedAt: row.updated_at,
		}));
	}

	listActiveSubscriptionsForPr(repo: string, prNumber: number): SessionSubscription[] {
		const rows = this.db
			.prepare(
				`SELECT session_subscriptions.*
				 FROM session_subscriptions
				 INNER JOIN sessions ON sessions.session_id = session_subscriptions.session_id
				 WHERE session_subscriptions.repo = :repo
				   AND session_subscriptions.pr_number = :prNumber
				   AND session_subscriptions.state = 'active'
				   AND sessions.status != 'closed'
				 ORDER BY session_subscriptions.created_at ASC`,
			)
			.all({ repo, prNumber }) as Array<{
				subscription_id: string; session_id: string; repo: string; pr_number: number; source: SubscriptionSource; state: SubscriptionState; last_delivered_event_seq: number; updated_at: number;
			}>;
		return rows.map((row) => ({
			subscriptionId: row.subscription_id, sessionId: row.session_id, repo: row.repo, prNumber: row.pr_number, source: row.source, state: row.state, lastDeliveredEventSeq: row.last_delivered_event_seq, updatedAt: row.updated_at,
		}));
	}

	baselineAutomaticSubscription(
		input: { sessionId: string; repo: string; prNumber: number },
		now = Date.now(),
	): SessionSubscription {
		return this.transaction(() => {
			const existing = this.getSubscription(input.sessionId, input.repo, input.prNumber);
			if (existing?.source === "manual" || existing?.state === "active") return existing;

			const row = this.db
				.prepare(`SELECT MAX(seq) AS max_seq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`)
				.get({ repo: input.repo, prNumber: input.prNumber }) as { max_seq: number | null } | undefined;
			const cursor = row?.max_seq ?? 0;
			const subscriptionId = existing?.subscriptionId ?? randomUUID();
			this.db
				.prepare(
					`INSERT INTO session_subscriptions (subscription_id, session_id, repo, pr_number, source, state, last_delivered_event_seq, created_at, updated_at)
					 VALUES (:subscriptionId, :sessionId, :repo, :prNumber, 'automatic', 'active', :cursor, :now, :now)
					 ON CONFLICT(session_id, repo, pr_number) DO UPDATE SET
					   state = 'active',
					   last_delivered_event_seq = :cursor,
					   updated_at = :now`,
				)
				.run({ ...input, subscriptionId, cursor, now });
			this.touchPrWatcher(input.repo, input.prNumber, now);
			return this.getSubscription(input.sessionId, input.repo, input.prNumber)!;
		});
	}

	unsubscribe(sessionId: string, repo: string, prNumber: number, now = Date.now()): boolean {
		return this.transaction(() => {
			const input = { sessionId, repo, prNumber, now };
			this.db
				.prepare(
					`DELETE FROM reminder_batches
					 WHERE subscription_id IN (
					   SELECT subscription_id FROM session_subscriptions
					   WHERE session_id = :sessionId AND repo = :repo AND pr_number = :prNumber
					 )`,
				)
				.run({ sessionId, repo, prNumber });
			const result = this.db
				.prepare(`UPDATE session_subscriptions SET state = 'unsubscribed', updated_at = :now WHERE session_id = :sessionId AND repo = :repo AND pr_number = :prNumber AND state = 'active'`)
				.run(input);
			if ((result.changes as number) > 0) this.refreshWatcherCounts(now);
			return (result.changes as number) > 0;
		});
	}

	deactivateAutomaticSubscriptions(sessionId: string, now = Date.now()) {
		return this.transaction(() => {
			this.db
				.prepare(
					`DELETE FROM reminder_batches
					 WHERE subscription_id IN (
					   SELECT subscription_id FROM session_subscriptions
					   WHERE session_id = :sessionId AND source = 'automatic'
					 )`,
				)
				.run({ sessionId });
			const result = this.db
				.prepare(`UPDATE session_subscriptions SET state = 'unsubscribed', updated_at = :now WHERE session_id = :sessionId AND source = 'automatic' AND state = 'active'`)
				.run({ sessionId, now });
			if ((result.changes as number) > 0) this.refreshWatcherCounts(now);
			return result.changes as number;
		});
	}

	rejectAutomaticPullRequest(
		sessionId: string,
		repo: string,
		prNumber: number,
		now = Date.now(),
	) {
		return this.transaction(() => {
			this.db
				.prepare(
					`DELETE FROM reminder_batches
					 WHERE session_id = :sessionId AND subscription_id IS NULL`,
				)
				.run({ sessionId });
			this.db
				.prepare(
					`UPDATE sessions
					 SET pr_number = NULL, last_delivered_event_seq = 0, updated_at = :now
					 WHERE session_id = :sessionId AND repo = :repo AND pr_number = :prNumber`,
				)
				.run({ sessionId, repo, prNumber, now });
			this.db
				.prepare(
					`UPDATE branch_watchers
					 SET pr_number = NULL, updated_at = :now
					 WHERE repo = :repo AND pr_number = :prNumber
					   AND branch = (SELECT branch FROM sessions WHERE session_id = :sessionId)`,
				)
				.run({ sessionId, repo, prNumber, now });
			return this.deactivateAutomaticSubscriptions(sessionId, now);
		});
	}

	suspendAutomaticSubscriptions(now = Date.now()) {
		const subscriptions = this.db
			.prepare(
				`SELECT session_id, repo, pr_number
				 FROM session_subscriptions
				 WHERE source = 'automatic' AND state = 'active'`,
			)
			.all() as Array<{ session_id: string; repo: string; pr_number: number }>;
		for (const subscription of subscriptions) {
			this.rejectAutomaticPullRequest(
				subscription.session_id,
				subscription.repo,
				subscription.pr_number,
				now,
			);
		}
		this.db
			.prepare(`UPDATE branch_watchers SET pr_number = NULL, updated_at = :now WHERE pr_number IS NOT NULL`)
			.run({ now });
		return subscriptions.length;
	}

	recordAutomaticSubscriptionOptOut(
		input: { sessionId: string; gitDir: string; repo: string; branch: string; prNumber: number },
		now = Date.now(),
	) {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO automatic_subscription_opt_outs (session_id, git_dir, repo, branch, pr_number, created_at)
				 VALUES (:sessionId, :gitDir, :repo, :branch, :prNumber, :now)`,
			)
			.run({ ...input, now });
	}

	hasAutomaticSubscriptionOptOut(input: { sessionId: string; gitDir: string; repo: string; branch: string; prNumber: number }): boolean {
		return Boolean(
			this.db
				.prepare(`SELECT 1 FROM automatic_subscription_opt_outs WHERE session_id = :sessionId AND git_dir = :gitDir AND repo = :repo AND branch = :branch AND pr_number = :prNumber`)
				.get(input),
		);
	}

	getAutomaticSubscriptionOptOutForBinding(input: {
		sessionId: string;
		gitDir: string;
		repo: string;
		branch: string;
	}): { prNumber: number; createdAt: number } | null {
		const row = this.db
			.prepare(
				`SELECT pr_number, created_at
				 FROM automatic_subscription_opt_outs
				 WHERE session_id = :sessionId
				   AND git_dir = :gitDir
				   AND repo = :repo
				   AND branch = :branch
				 ORDER BY created_at DESC, pr_number DESC
				 LIMIT 1`,
			)
			.get(input) as { pr_number: number; created_at: number } | undefined;
		return row ? { prNumber: row.pr_number, createdAt: row.created_at } : null;
	}

	/**
	 * Marks any non-closed session whose last_activity_at is older than the
	 * threshold as "closed". Also refreshes watcher counts when any rows were
	 * reaped so the next poll tick reflects reality.
	 *
	 * Records lastReapAt/lastReapCount on every call (including no-op sweeps)
	 * so operators can verify the sweep is actually running.
	 */
	reapStaleSessions(
		thresholdMs: number,
		now = Date.now(),
	): { reaped: number; oldestAgeMs: number | null } {
		const cutoff = now - thresholdMs;
		const result = this.db
			.prepare(
				`UPDATE sessions SET status = 'closed', updated_at = :now WHERE status != 'closed' AND last_activity_at < :cutoff`,
			)
			.run({ now, cutoff });

		const reaped = result.changes as number;
		if (reaped > 0) this.refreshWatcherCounts(now);

		const oldestRow = this.db
			.prepare(
				`SELECT MIN(last_activity_at) AS oldest FROM sessions WHERE status != 'closed'`,
			)
			.get() as { oldest: number | null };
		const oldestAgeMs =
			oldestRow.oldest === null ? null : now - oldestRow.oldest;

		this.lastReapAt = now;
		this.lastReapCount = reaped;

		return { reaped, oldestAgeMs };
	}

	getLastReapAt(): number | null {
		return this.lastReapAt;
	}

	getLastReapCount(): number {
		return this.lastReapCount;
	}

	/**
	 * Permanently deletes closed session rows (and their reminder_batches via
	 * CASCADE) that have been closed for longer than retentionMs. This prevents
	 * indefinite accumulation of stale tracking rows that will never receive
	 * delivery.
	 *
	 * Does NOT affect opencode's own session store — premind's DB is a local
	 * tracking layer only.
	 */
	pruneClosedSessions(retentionMs: number, now = Date.now()): number {
		const cutoff = now - retentionMs;
		const result = this.db
			.prepare(
				`DELETE FROM sessions WHERE status = 'closed' AND updated_at < :cutoff`,
			)
			.run({ cutoff });
		return result.changes as number;
	}

	pruneClosedOrOrphanedSessions() {
		const predicate = `status = 'closed' OR NOT EXISTS (SELECT 1 FROM client_leases WHERE client_leases.client_id = sessions.client_id)`;
		const deletedBatches = this.db
			.prepare(
				`DELETE FROM reminder_batches WHERE session_id IN (SELECT session_id FROM sessions WHERE ${predicate})`,
			)
			.run();
		const deletedSessions = this.db
			.prepare(`DELETE FROM sessions WHERE ${predicate}`)
			.run();
		return {
			sessions: deletedSessions.changes as number,
			reminderBatches: deletedBatches.changes as number,
		};
	}

	/**
	 * Prunes inactive subscription cursors and expired stopped/terminal PR streams.
	 * Active subscriptions always retain their stream, including while their owning
	 * session is awaiting separate session-retention cleanup.
	 */
	pruneExpiredPrStreams(
		now = Date.now(),
		streamRetentionMs = PREMIND_PR_STREAM_RETENTION_MS,
		subscriptionRetentionMs = PREMIND_SUBSCRIPTION_RETENTION_MS,
	): PrStreamPruneResult {
		return this.transaction(() => {
			const subscriptions = this.db
				.prepare(
					`DELETE FROM session_subscriptions
					 WHERE state = 'unsubscribed' AND updated_at <= :subscriptionCutoff`,
				)
				.run({ subscriptionCutoff: now - subscriptionRetentionMs });

			const expiredStreams = `
				SELECT repo, pr_number
				FROM pr_watchers
				WHERE state IN ('stopped', 'terminal')
				  AND COALESCE(terminal_at, idle_deadline_at, updated_at) <= :streamCutoff
				  AND NOT EXISTS (
				    SELECT 1 FROM session_subscriptions
				    WHERE session_subscriptions.repo = pr_watchers.repo
				      AND session_subscriptions.pr_number = pr_watchers.pr_number
				      AND session_subscriptions.state = 'active'
				  )
			`;
			const parameters = { streamCutoff: now - streamRetentionMs };
			const snapshots = this.db
				.prepare(`DELETE FROM pr_snapshots WHERE (repo, pr_number) IN (${expiredStreams})`)
				.run(parameters);
			const events = this.db
				.prepare(`DELETE FROM pr_events WHERE (repo, pr_number) IN (${expiredStreams})`)
				.run(parameters);
			this.db
				.prepare(
					`DELETE FROM etags
					 WHERE scope = 'pr.snapshot'
					   AND EXISTS (
					     SELECT 1 FROM pr_watchers
					     WHERE etags.key = pr_watchers.repo || '#' || pr_watchers.pr_number
					       AND (pr_watchers.repo, pr_watchers.pr_number) IN (${expiredStreams})
					   )`,
				)
				.run(parameters);
			const watchers = this.db
				.prepare(`DELETE FROM pr_watchers WHERE (repo, pr_number) IN (${expiredStreams})`)
				.run(parameters);

			return {
				events: events.changes as number,
				snapshots: snapshots.changes as number,
				watchers: watchers.changes as number,
				subscriptions: subscriptions.changes as number,
			};
		});
	}

	/** Backward-compatible event-count facade for the daemon's retention sweep. */
	pruneOrphanedPrEvents(now = Date.now()): number {
		return this.pruneExpiredPrStreams(now).events;
	}

	countClosedSessions(): number {
		const row = this.db
			.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'closed'`)
			.get() as { count: number };
		return row.count;
	}

	getSession(sessionId: string) {
		return this.db
			.prepare(`SELECT * FROM sessions WHERE session_id = ?`)
			.get(sessionId) as SessionRow | undefined;
	}

	listSessionSummaries() {
		const sessions = this.db
			.prepare(
				`SELECT session_id, repo, branch, pr_number, status, busy_state, last_delivered_event_seq FROM sessions WHERE status != 'closed' ORDER BY updated_at DESC`,
			)
			.all() as Array<{
			session_id: string;
			repo: string;
			branch: string;
			pr_number: number | null;
			status: "active" | "paused" | "closed";
			busy_state: "busy" | "idle";
			last_delivered_event_seq: number;
		}>;

		return sessions.map((session) => {
			const subscriptions = this.listSessionSubscriptions(session.session_id).map(
				(subscription) => ({
					repo: subscription.repo,
					prNumber: subscription.prNumber,
					source: subscription.source,
					state: subscription.state,
					pendingEventCount:
						subscription.state === "active"
							? this.countPendingEvents(
									subscription.repo,
									subscription.prNumber,
									subscription.lastDeliveredEventSeq,
								)
							: 0,
				}),
			);
			const pendingReminderCount =
				subscriptions.length > 0
					? subscriptions
							.filter((subscription) => subscription.state === "active")
							.reduce((count, subscription) => count + subscription.pendingEventCount, 0)
					: session.pr_number === null
							? 0
							: this.countPendingEvents(
									session.repo,
									session.pr_number,
									session.last_delivered_event_seq,
								);
			const binding = this.getWorktreeBinding(session.session_id);

			return {
				sessionId: session.session_id,
				repo: session.repo,
				branch: session.branch,
				prNumber: session.pr_number,
				status: session.status,
				busyState: session.busy_state,
				pendingReminderCount,
				worktreeBinding: binding
					? {
							root: binding.root,
							gitDir: binding.gitDir,
							repo: binding.repo,
							branch: binding.branch,
							headSha: binding.headSha,
							state: binding.state,
							updatedAt: binding.updatedAt,
						}
					: null,
				subscriptions,
			};
		});
	}

	private countPendingEvents(repo: string, prNumber: number, lastDeliveredEventSeq: number) {
		return (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM pr_events WHERE repo = :repo AND pr_number = :prNumber AND seq > :lastDeliveredEventSeq`,
				)
				.get({ repo, prNumber, lastDeliveredEventSeq }) as { count: number }
		).count;
	}

	setSessionPaused(sessionId: string, paused: boolean, now = Date.now()) {
		const status = paused ? "paused" : "active";
		const result = this.db
			.prepare(
				`UPDATE sessions SET status = :status, updated_at = :now WHERE session_id = :sessionId`,
			)
			.run({ status, now, sessionId });
		return (result.changes as number) > 0;
	}

	isGloballyDisabled(): boolean {
		const row = this.db
			.prepare(`SELECT value FROM settings WHERE key = 'globally_disabled'`)
			.get() as { value: string } | undefined;
		return row?.value === "true";
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
			.run({ value: disabled ? "true" : "false", now });
	}

	countActiveClients(now = Date.now()) {
		this.pruneExpiredClients(now);
		const row = this.db
			.prepare(`SELECT COUNT(*) AS count FROM client_leases`)
			.get() as { count: number };
		return row.count;
	}

	countActiveSessions() {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM sessions WHERE status != 'closed'`,
			)
			.get() as { count: number };
		return row.count;
	}

	countActiveWatchers() {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM pr_watchers WHERE active_session_count > 0`,
			)
			.get() as { count: number };
		return row.count;
	}

	hasDaemonDemand(now = Date.now()): boolean {
		if (this.countActiveClients(now) > 0) return true;
		this.refreshWatcherCounts(now);
		const row = this.db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM session_subscriptions
				      INNER JOIN sessions USING (session_id)
				      WHERE session_subscriptions.state = 'active' AND sessions.status != 'closed') +
				   (SELECT COUNT(*) FROM pr_watchers WHERE active_session_count > 0) +
				   (SELECT COUNT(*) FROM branch_watchers WHERE active_session_count > 0)
				 AS count`,
			)
			.get() as { count: number };
		return row.count > 0;
	}

	listBranchWatchTargets(now = Date.now()) {
		this.pruneExpiredClients(now);
		this.refreshWatcherCounts(now);
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
			repo: string;
			branch: string;
			pr_number: number | null;
			last_checked_at: number | null;
			active_session_count: number;
		}>;
	}

	listActiveWorktreeBranchTargets(now = Date.now()) {
		this.pruneExpiredClients(now);
		return this.db
			.prepare(
				`SELECT sessions.session_id, worktree_bindings.git_dir, worktree_bindings.repo, worktree_bindings.branch, branch_watchers.pr_number
				 FROM worktree_bindings
				 INNER JOIN sessions ON sessions.session_id = worktree_bindings.session_id
				 LEFT JOIN branch_watchers
				   ON branch_watchers.repo = worktree_bindings.repo
				  AND branch_watchers.branch = worktree_bindings.branch
				 WHERE sessions.status != 'closed'
				   AND worktree_bindings.branch IS NOT NULL
				   AND worktree_bindings.state != 'detached_head'
				 UNION ALL
				 SELECT sessions.session_id, '' AS git_dir, sessions.repo, sessions.branch, branch_watchers.pr_number
				 FROM sessions
				 LEFT JOIN worktree_bindings ON worktree_bindings.session_id = sessions.session_id
				 LEFT JOIN branch_watchers
				   ON branch_watchers.repo = sessions.repo
				  AND branch_watchers.branch = sessions.branch
				 WHERE sessions.status != 'closed'
				   AND worktree_bindings.session_id IS NULL
				 `
			)
			.all() as Array<{
			session_id: string;
			git_dir: string;
			repo: string;
			branch: string;
			pr_number: number | null;
		}>;
	}

	recordBranchAssociation(
		repo: string,
		branch: string,
		prNumber: number | null,
		checkedAt = Date.now(),
	) {
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
			.run({ repo, branch, prNumber, checkedAt });

		// Find sessions whose pr_number is about to change. For any session that is newly
		// associated with a PR (or switched to a different PR), fast-forward its delivery
		// cursor past any pre-existing events for that PR. This prevents replaying history
		// the user has either already seen (re-attach case) or never saw but wouldn't want
		// dumped at once (stale event log).
		const sessionsToUpdate = this.db
			.prepare(
				`SELECT session_id, pr_number FROM sessions WHERE repo = :repo AND branch = :branch`,
			)
			.all({ repo, branch }) as Array<{
			session_id: string;
			pr_number: number | null;
		}>;

		let freshCursor = 0;
		if (prNumber !== null) {
			const row = this.db
				.prepare(
					`SELECT MAX(seq) AS maxSeq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`,
				)
				.get({ repo, prNumber }) as { maxSeq: number | null } | undefined;
			freshCursor = row?.maxSeq ?? 0;
		}

		this.db
			.prepare(
				`UPDATE sessions SET pr_number = :prNumber, updated_at = :checkedAt WHERE repo = :repo AND branch = :branch`,
			)
			.run({ repo, branch, prNumber, checkedAt });

		if (prNumber !== null && freshCursor > 0) {
			const advance = this.db.prepare(
				`UPDATE sessions SET last_delivered_event_seq = :cursor WHERE session_id = :sessionId`,
			);
			for (const session of sessionsToUpdate) {
				if (session.pr_number !== prNumber) {
					advance.run({ cursor: freshCursor, sessionId: session.session_id });
				}
			}
		}

		if (prNumber !== null) {
			// Compatibility seam for adapters that have not yet activated a worktree.
			// New branch discovery never calls this path; it owns subscriptions from bindings.
			const legacySessions = this.db
				.prepare(
					`SELECT sessions.session_id FROM sessions
					 LEFT JOIN worktree_bindings ON worktree_bindings.session_id = sessions.session_id
					 WHERE sessions.repo = :repo AND sessions.branch = :branch
					   AND worktree_bindings.session_id IS NULL`,
				)
				.all({ repo, branch }) as Array<{ session_id: string }>;
			for (const session of legacySessions) {
				this.baselineAutomaticSubscription({
					sessionId: session.session_id,
					repo,
					prNumber,
				}, checkedAt);
			}
		}

		if (prNumber !== null) {
			this.touchPrWatcher(repo, prNumber, checkedAt);
		}
	}

	getSnapshot(repo: string, prNumber: number) {
		const row = this.db
			.prepare(
				`SELECT snapshot_json FROM pr_snapshots WHERE repo = ? AND pr_number = ?`,
			)
			.get(repo, prNumber) as { snapshot_json: string } | undefined;
		if (!row) return null;
		try {
			return JSON.parse(row.snapshot_json) as PullRequestSnapshot;
		} catch {
			return null;
		}
	}

	/**
	 * ETag cache for conditional GitHub requests. `scope` is a short tag
	 * (e.g. "pr.snapshot", "branch.pulls"); `key` uniquely identifies the
	 * resource within that scope (e.g. `${repo}#${prNumber}`).
	 */
	getEtag(scope: string, key: string): string | null {
		const row = this.db
			.prepare(`SELECT etag FROM etags WHERE scope = ? AND key = ?`)
			.get(scope, key) as { etag: string } | undefined;
		return row?.etag ?? null;
	}

	saveEtag(scope: string, key: string, etag: string | null, now = Date.now()) {
		if (etag === null) {
			this.db
				.prepare(`DELETE FROM etags WHERE scope = ? AND key = ?`)
				.run(scope, key);
			return;
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
			.run({ scope, key, etag, now });
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
			});
	}

	saveSnapshotAndEvents(
		repo: string,
		prNumber: number,
		snapshot: PullRequestSnapshot,
		events: NormalizedPrEvent[],
		now = Date.now(),
	) {
		this.db.exec("BEGIN");
		try {
			this.saveSnapshot(repo, prNumber, snapshot);
			this.insertEventsInTransaction(repo, prNumber, events, now);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	saveTerminalSnapshotAndEvents(
		repo: string,
		prNumber: number,
		snapshot: PullRequestSnapshot,
		events: NormalizedPrEvent[],
		etag: string | null,
		now = Date.now(),
	): void {
		this.transaction(() => {
			this.saveSnapshot(repo, prNumber, snapshot);
			this.insertEventsInTransaction(repo, prNumber, events, now);
			this.saveEtag("pr.snapshot", `${repo}#${prNumber}`, etag, now);
			this.persistPrWatcherLifecycle(
				{
					repo,
					prNumber,
					state: "terminal",
					idleDeadlineAt: null,
					terminalAt: now,
					nextEligiblePollAt: null,
					consecutiveFailures: 0,
					lastFailureAt: null,
					lastFailureMessage: null,
					rateLimitResetAt: null,
				},
				now,
			);
		});
	}

	insertEvents(
		repo: string,
		prNumber: number,
		events: NormalizedPrEvent[],
		now = Date.now(),
	) {
		this.db.exec("BEGIN");
		try {
			this.insertEventsInTransaction(repo, prNumber, events, now);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private insertEventsInTransaction(
		repo: string,
		prNumber: number,
		events: NormalizedPrEvent[],
		now: number,
	) {
		const insert = this.db.prepare(
			`
				INSERT OR IGNORE INTO pr_events (repo, pr_number, dedupe_key, kind, priority, summary, reference_link, payload_json, created_at)
				VALUES (:repo, :prNumber, :dedupeKey, :kind, :priority, :summary, :referenceLink, :payloadJson, :now)
			`,
		);

		for (const event of events) {
			// Prefer the local detail file (rich body content for comments and
			// reviews). When the writer skips the file (no rich content for this
			// kind, e.g. check.*), fall back to the GitHub URL the event was
			// built with so the reminder still carries an actionable link.
			const localPath = this.detailFiles.write(repo, prNumber, event);
			const referenceLink = localPath ?? event.referenceLink ?? null;
			insert.run({
				repo,
				prNumber,
				dedupeKey: event.dedupeKey,
				kind: event.kind,
				priority: event.priority,
				summary: event.summary,
				referenceLink,
				payloadJson: JSON.stringify(event.payload),
				now,
			});
		}
	}

	listPrWatchTargets(now = Date.now()) {
		this.pruneExpiredClients(now);
		return this.db
			.prepare(
				`SELECT session_subscriptions.repo, session_subscriptions.pr_number,
				        COUNT(*) AS active_session_count, pr_watchers.last_checked_at
				 FROM session_subscriptions
				 INNER JOIN sessions ON sessions.session_id = session_subscriptions.session_id
				 LEFT JOIN pr_watchers
				   ON pr_watchers.repo = session_subscriptions.repo
				  AND pr_watchers.pr_number = session_subscriptions.pr_number
				 WHERE session_subscriptions.state = 'active'
				   AND sessions.status != 'closed'
				 GROUP BY session_subscriptions.repo, session_subscriptions.pr_number
				 ORDER BY MIN(session_subscriptions.updated_at) ASC`,
			)
			.all() as Array<{
			repo: string;
			pr_number: number;
			active_session_count: number;
			last_checked_at: number | null;
		}>;
	}

	listPrWatcherRecords(now = Date.now()): PrWatcherRecord[] {
		this.pruneExpiredClients(now);
		this.refreshWatcherCounts(now);
		const rows = this.db.prepare(`SELECT * FROM pr_watchers ORDER BY created_at ASC`).all() as Array<{
			repo: string;
			pr_number: number;
			state: PrWatcherState;
			active_session_count: number;
			last_checked_at: number | null;
			idle_deadline_at: number | null;
			terminal_at: number | null;
			next_eligible_poll_at: number | null;
			consecutive_failures: number;
			last_failure_at: number | null;
			last_failure_message: string | null;
			rate_limit_reset_at: number | null;
			created_at: number;
			updated_at: number;
		}>;
		return rows.map((row) => ({
			repo: row.repo,
			prNumber: row.pr_number,
			state: row.state,
			activeSubscriberCount: row.active_session_count,
			lastCheckedAt: row.last_checked_at,
			idleDeadlineAt: row.idle_deadline_at,
			terminalAt: row.terminal_at,
			nextEligiblePollAt: row.next_eligible_poll_at,
			consecutiveFailures: row.consecutive_failures,
			lastFailureAt: row.last_failure_at,
			lastFailureMessage: row.last_failure_message,
			rateLimitResetAt: row.rate_limit_reset_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	getPrWatcherRecord(repo: string, prNumber: number): PrWatcherRecord | null {
		return this.listPrWatcherRecords().find(
			(record) => record.repo === repo && record.prNumber === prNumber,
		) ?? null;
	}

	persistPrWatcherLifecycle(
		record: Pick<
			PrWatcherRecord,
			| "repo"
			| "prNumber"
			| "state"
			| "idleDeadlineAt"
			| "terminalAt"
			| "nextEligiblePollAt"
			| "consecutiveFailures"
			| "lastFailureAt"
			| "lastFailureMessage"
			| "rateLimitResetAt"
		>,
		now = Date.now(),
	): void {
		this.db
			.prepare(
				`UPDATE pr_watchers
				 SET state = :state,
				     idle_deadline_at = :idleDeadlineAt,
				     terminal_at = :terminalAt,
				     next_eligible_poll_at = :nextEligiblePollAt,
				     consecutive_failures = :consecutiveFailures,
				     last_failure_at = :lastFailureAt,
				     last_failure_message = :lastFailureMessage,
				     rate_limit_reset_at = :rateLimitResetAt,
				     updated_at = :now
				 WHERE repo = :repo AND pr_number = :prNumber`,
			)
			.run({ ...record, now });
	}

	markPrWatchChecked(repo: string, prNumber: number, checkedAt = Date.now()) {
		this.db
			.prepare(
				`UPDATE pr_watchers SET last_checked_at = :checkedAt, updated_at = :checkedAt WHERE repo = :repo AND pr_number = :prNumber`,
			)
			.run({ repo, prNumber, checkedAt });
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
			.all({ repo, prNumber }) as SessionRow[];
	}

	listUndeliveredEvents(sessionId: string, limit = 20) {
		const subscriptions = this.listSessionSubscriptions(sessionId, "active");
		for (const subscription of subscriptions) {
			const events = this.listUndeliveredEventsForSubscription(subscription.subscriptionId, limit);
			if (events.length > 0) return events;
		}
		if (subscriptions.length > 0) return [];

		// Legacy adapters still identify a stream through sessions.pr_number. New
		// watchers and subscription-owned batches never take this fallback.
		const session = this.getSession(sessionId);
		if (!session || session.pr_number === null) return [];
		return this.listEventsAfterCursor(
			session.repo,
			session.pr_number,
			session.last_delivered_event_seq,
			limit,
		);
	}

	listUndeliveredEventsForSubscription(subscriptionId: string, limit = 20) {
		const subscription = this.getSubscriptionById(subscriptionId);
		if (!subscription || subscription.state !== "active") return [];
		return this.listEventsAfterCursor(
			subscription.repo,
			subscription.prNumber,
			subscription.lastDeliveredEventSeq,
			limit,
		);
	}

	private listEventsAfterCursor(
		repo: string,
		prNumber: number,
		lastDeliveredEventSeq: number,
		limit: number,
	) {
		return this.db
			.prepare(
				`SELECT seq, kind, priority, summary, reference_link
				 FROM pr_events
				 WHERE repo = :repo
				   AND pr_number = :prNumber
				   AND seq > :lastDeliveredEventSeq
				 ORDER BY seq ASC
				 LIMIT :limit`,
			)
			.all({ repo, prNumber, lastDeliveredEventSeq, limit }) as EventRow[];
	}

	createOrReplaceReminder(
		sessionId: string,
		subscriptionId: string | null,
		reminderText: string,
		events: ReminderEvent[],
		maxEventSeq: number,
		now = Date.now(),
	) {
		const batchId = randomUUID();
		this.db
			.prepare(
				`INSERT INTO reminder_batches (batch_id, session_id, subscription_id, reminder_text, events_json, state, max_event_seq, created_at, updated_at)
				 VALUES (:batchId, :sessionId, :subscriptionId, :reminderText, :eventsJson, 'built', :maxEventSeq, :now, :now)`,
			)
			.run({
				batchId,
				sessionId,
				subscriptionId,
				reminderText,
				eventsJson: JSON.stringify(events),
				maxEventSeq,
				now,
			});
		return batchId;
	}

	getPendingReminder(sessionId: string): ReminderBatch | null {
		const record = this.getPendingReminderRecord(sessionId);
		return record ? this.toReminderBatch(record) : null;
	}

	getPendingReminderRecord(sessionId: string): ReminderBatchRecord | null {
		const row = this.db
			.prepare(
				`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
				        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state,
				        reminder_batches.max_event_seq, session_subscriptions.repo,
				        session_subscriptions.pr_number, session_subscriptions.source
				 FROM reminder_batches
				 LEFT JOIN session_subscriptions
				   ON session_subscriptions.subscription_id = reminder_batches.subscription_id
				 WHERE reminder_batches.session_id = :sessionId
				   AND reminder_batches.state IN ('built', 'failed')
				   AND (reminder_batches.subscription_id IS NULL OR session_subscriptions.state = 'active')
				 ORDER BY reminder_batches.created_at ASC LIMIT 1`,
			)
			.get({ sessionId }) as ReminderRow | undefined;
		return this.toReminderBatchRecord(row);
	}

	getReminderBatchRecord(
		batchId: string,
		sessionId?: string,
	): ReminderBatchRecord | null {
		const row = (sessionId
			? this.db
					.prepare(
						`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
						        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq,
						        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
						 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
						 WHERE batch_id = :batchId AND reminder_batches.session_id = :sessionId`,
					)
					.get({ batchId, sessionId })
			: this.db
					.prepare(
						`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
						        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq,
						        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
						 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
						 WHERE batch_id = :batchId`,
					)
					.get({ batchId })) as ReminderRow | undefined;
		return this.toReminderBatchRecord(row);
	}

	listPendingReminderBatchRecords(): ReminderBatchRecord[] {
		const rows = this.db
			.prepare(
				`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
				        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq,
				        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
				 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
				 WHERE reminder_batches.state != 'confirmed' ORDER BY reminder_batches.created_at ASC`,
			)
			.all() as ReminderRow[];
		return rows.flatMap((row) => {
			const record = this.toReminderBatchRecord(row);
			return record ? [record] : [];
		});
	}

	private getPendingReminderForSubscription(subscriptionId: string): ReminderBatch | null {
		const row = this.db
			.prepare(
				`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
				        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state,
				        reminder_batches.max_event_seq, session_subscriptions.repo,
				        session_subscriptions.pr_number, session_subscriptions.source
				 FROM reminder_batches
				 INNER JOIN session_subscriptions
				   ON session_subscriptions.subscription_id = reminder_batches.subscription_id
				 WHERE reminder_batches.subscription_id = :subscriptionId
				   AND reminder_batches.state IN ('built', 'failed')
				   AND session_subscriptions.state = 'active'`,
			)
			.get({ subscriptionId }) as ReminderRow | undefined;
		const record = this.toReminderBatchRecord(row);
		return record ? this.toReminderBatch(record) : null;
	}

	private toReminderBatch(record: ReminderBatchRecord): ReminderBatch {
		return {
			batchId: record.batchId,
			sessionId: record.sessionId,
			...(record.repo ? { repo: record.repo } : {}),
			...(record.prNumber ? { prNumber: record.prNumber } : {}),
			...(record.subscriptionId ? { subscriptionId: record.subscriptionId } : {}),
			...(record.source ? { source: record.source } : {}),
			reminderText: record.reminderText,
			events: record.events,
		};
	}

	private toReminderBatchRecord(row: ReminderRow | undefined): ReminderBatchRecord | null {
		if (!row || row.state === "confirmed") return null;
		try {
			return {
				batchId: row.batch_id,
				sessionId: row.session_id,
				subscriptionId: row.subscription_id,
				repo: row.repo ?? undefined,
				prNumber: row.pr_number ?? undefined,
				source: row.source ?? undefined,
				reminderText: row.reminder_text,
				events: JSON.parse(row.events_json) as ReminderEvent[],
				state: row.state,
				maxEventSeq: row.max_event_seq,
			};
		} catch {
			return null;
		}
	}

	transitionReminderBatchState(
		batchId: string,
		sessionId: string,
		expectedState: ReminderHandoffState,
		nextState: ReminderHandoffState,
		now = Date.now(),
	): boolean {
		const valid =
			(expectedState === "built" && nextState === "handed_off") ||
			(expectedState === "handed_off" && nextState === "failed") ||
			(expectedState === "failed" && nextState === "built");
		if (!valid) return false;
		const result = this.db
			.prepare(
				`UPDATE reminder_batches SET state = :nextState, updated_at = :now
				 WHERE batch_id = :batchId AND session_id = :sessionId AND state = :expectedState`,
			)
			.run({ batchId, sessionId, expectedState, nextState, now });
		return (result.changes as number) === 1;
	}

	confirmReminderBatch(batchId: string, sessionId: string, now = Date.now()): boolean {
		return this.transaction(() => {
			const row = this.db
				.prepare(
					`SELECT subscription_id, max_event_seq FROM reminder_batches
					 WHERE batch_id = :batchId AND session_id = :sessionId AND state = 'handed_off'`,
				)
				.get({ batchId, sessionId }) as
				| { subscription_id: string | null; max_event_seq: number | null }
				| undefined;
			if (!row) return false;

			const confirmed = this.db
				.prepare(
					`UPDATE reminder_batches SET state = 'confirmed', updated_at = :now
					 WHERE batch_id = :batchId AND session_id = :sessionId AND state = 'handed_off'`,
				)
				.run({ batchId, sessionId, now });
			if ((confirmed.changes as number) !== 1) return false;

			if (row.max_event_seq !== null) {
				if (row.subscription_id) {
					this.db
						.prepare(
							`UPDATE session_subscriptions
							 SET last_delivered_event_seq = MAX(last_delivered_event_seq, :seq), updated_at = :now
							 WHERE subscription_id = :subscriptionId`,
						)
						.run({ seq: row.max_event_seq, now, subscriptionId: row.subscription_id });
				}
				// Keep the legacy session cursor synchronized until all adapters and
				// migrations exclusively consume subscription-owned cursors.
				this.db
					.prepare(
						`UPDATE sessions
						 SET last_delivered_event_seq = MAX(last_delivered_event_seq, :seq), updated_at = :now
						 WHERE session_id = :sessionId`,
					)
					.run({ seq: row.max_event_seq, now, sessionId });
			}
			this.db
				.prepare(`DELETE FROM reminder_batches WHERE batch_id = :batchId AND state = 'confirmed'`)
				.run({ batchId });
			return true;
		});
	}

	ackReminder(payload: AckReminderPayload, now = Date.now()) {
		const record = this.getReminderBatchRecord(payload.batchId, payload.sessionId);
		if (!record) return false;
		const actor = createReminderHandoffActor(record.state);
		actor.send(eventForReminderState(payload.state));
		const accepted = actor.getSnapshot().value === payload.state;
		actor.stop();
		if (!accepted) return false;

		switch (payload.state) {
			case "handed_off":
				return this.transitionReminderBatchState(
					payload.batchId,
					payload.sessionId,
					"built",
					"handed_off",
					now,
				);
			case "failed":
				return this.transitionReminderBatchState(
					payload.batchId,
					payload.sessionId,
					"handed_off",
					"failed",
					now,
				);
			case "confirmed":
				return this.confirmReminderBatch(payload.batchId, payload.sessionId, now);
		}
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
			.all({ repo, branch }) as SessionRow[];
	}

	buildReminderBatch(
		sessionId: string,
		now = Date.now(),
		subscriptionId?: string,
	): ReminderBatch | null {
		const session = this.getSession(sessionId);
		if (!session || session.status === "paused" || session.status === "closed")
			return null;

		const subscription = subscriptionId
			? this.getSubscriptionById(subscriptionId)
			: this.listSessionSubscriptions(sessionId, "active").find(
					(candidate) => this.listUndeliveredEventsForSubscription(candidate.subscriptionId).length > 0,
				);
		if (
			subscription &&
			(subscription.sessionId !== sessionId || subscription.state !== "active")
		) return null;

		const existing = subscription
			? this.getPendingReminderForSubscription(subscription.subscriptionId)
			: this.getPendingReminder(sessionId);
		if (existing) return existing;

		const events = subscription
			? this.listUndeliveredEventsForSubscription(subscription.subscriptionId)
			: this.listUndeliveredEvents(sessionId);
		if (events.length === 0) return null;
		const maxEventSeq = events.at(-1)!.seq;

		const reminderEvents: GroupedReminderEvent[] = events.map((event) => ({
			eventId: String(event.seq),
			kind: event.kind,
			priority: event.priority,
			summary: event.summary,
			referenceLink: event.reference_link ?? undefined,
		}));

		const grouped = new Map<string, GroupedReminderEvent[]>();
		for (const event of reminderEvents) {
			const key =
				event.priority === "low" || event.priority === "medium"
					? `${event.priority}:${event.kind}`
					: event.eventId;
			const bucket = grouped.get(key);
			if (bucket) bucket.push(event);
			else grouped.set(key, [event]);
		}

		const condensed = Array.from(grouped.values()).map((bucket) => {
			if (bucket.length === 1 || bucket[0].priority === "high")
				return bucket[0];
			return {
				...bucket[0],
				summary: `${bucket.length} ${bucket[0].kind.replaceAll("_", " ")} events (${bucket
					.slice(0, 2)
					.map((event) => event.summary)
					.join("; ")})`,
				count: bucket.length,
				samples: bucket.slice(0, 2).map((event) => event.summary),
			};
		});

		condensed.sort((left, right) => {
			const priorityDelta =
				priorityRank[left.priority] - priorityRank[right.priority];
			if (priorityDelta !== 0) return priorityDelta;
			return Number(left.eventId) - Number(right.eventId);
		});
		const hasActionableBlocker = condensed.some((event) =>
			["check.failed", "merge_conflict.detected"].includes(event.kind),
		);
		const targetRepo = subscription?.repo ?? session.repo;
		const targetPrNumber = subscription?.prNumber ?? session.pr_number;
		const qualifiedTarget = targetPrNumber ? `${targetRepo}#${targetPrNumber}` : targetRepo;
		const reminderText = [
			"<system-reminder>",
			`New pull request context was detected for ${qualifiedTarget} since the last reminder.`,
			...(subscription?.source === "manual"
				? [
					"",
					"This PR is manually subscribed. Do not make changes unless the user explicitly asks you to.",
				]
				: []),
			"",
			"Changes:",
			...condensed.map(

				(event, index) =>
					`${index + 1}. ${event.kind} - ${event.summary}${event.referenceLink ? ` (${event.referenceLink})` : ""}`,
			),
			...(hasActionableBlocker
				? [
					"",
					subscription?.source === "manual"
						? "Action required: report the failing checks or merge conflicts above to the user and wait for explicit authorization before making changes."
						: "Action required: investigate and address the failing checks or merge conflicts above before continuing the current task. If you cannot resolve them, explain why.",
				]
				: []),
			"",
			"Please incorporate only the new information above into your reasoning and continue the current task.",
			"</system-reminder>",
		].join("\n");
		const batchId = this.createOrReplaceReminder(
			sessionId,
			subscription?.subscriptionId ?? null,
			reminderText,
			condensed,
			maxEventSeq,
			now,
		);
		return {
			batchId,
			sessionId,
			repo: targetRepo,
			...(targetPrNumber ? { prNumber: targetPrNumber } : {}),
			...(subscription ? { subscriptionId: subscription.subscriptionId, source: subscription.source } : {}),
			reminderText,
			events: condensed,
		};
	}

	buildReminderBatchForSubscription(
		subscriptionId: string,
		now = Date.now(),
	): ReminderBatch | null {
		const subscription = this.getSubscriptionById(subscriptionId);
		if (!subscription || subscription.state !== "active") return null;
		return this.buildReminderBatch(subscription.sessionId, now, subscriptionId);
	}

	ensureBranchWatcher(repo: string, branch: string, now = Date.now()) {
		this.touchBranchWatcher(repo, branch, now);
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
			.run({ repo, branch, now });
		this.refreshWatcherCounts(now);
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
			.run({ repo, prNumber, now });
		this.refreshWatcherCounts(now);
	}

	private refreshWatcherCounts(now = Date.now()) {
		this.db
			.prepare(
				`UPDATE branch_watchers SET active_session_count = 0, updated_at = :now`,
			)
			.run({ now });
		this.db
			.prepare(
				`
          UPDATE branch_watchers
          SET active_session_count = (
            SELECT COUNT(*)
            FROM sessions
            LEFT JOIN worktree_bindings
              ON worktree_bindings.session_id = sessions.session_id
            WHERE sessions.status != 'closed'
              AND (
                (worktree_bindings.session_id IS NOT NULL
                  AND worktree_bindings.repo = branch_watchers.repo
                  AND worktree_bindings.branch = branch_watchers.branch)
                OR (worktree_bindings.session_id IS NULL
                  AND sessions.repo = branch_watchers.repo
                  AND sessions.branch = branch_watchers.branch)
              )
          ),
              updated_at = :now
        `,
			)
			.run({ now });

		this.db
			.prepare(
				`
          UPDATE pr_watchers
          SET active_session_count = (
            SELECT COUNT(*)
            FROM session_subscriptions
            INNER JOIN sessions
              ON sessions.session_id = session_subscriptions.session_id
            WHERE session_subscriptions.repo = pr_watchers.repo
              AND session_subscriptions.pr_number = pr_watchers.pr_number
              AND session_subscriptions.state = 'active'
              AND sessions.status != 'closed'
          ),
              updated_at = CASE
                WHEN active_session_count != (
                  SELECT COUNT(*)
                  FROM session_subscriptions
                  INNER JOIN sessions
                    ON sessions.session_id = session_subscriptions.session_id
                  WHERE session_subscriptions.repo = pr_watchers.repo
                    AND session_subscriptions.pr_number = pr_watchers.pr_number
                    AND session_subscriptions.state = 'active'
                    AND sessions.status != 'closed'
                ) THEN :now
                ELSE updated_at
              END
        `,
			)
			.run({ now });
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

      CREATE TABLE IF NOT EXISTS worktree_bindings (
        session_id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        head_sha TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('automatic', 'manual')),
        state TEXT NOT NULL CHECK(state IN ('active', 'unsubscribed')),
        last_delivered_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, repo, pr_number),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS session_subscriptions_active_pr
      ON session_subscriptions(repo, pr_number, state);

      CREATE TABLE IF NOT EXISTS automatic_subscription_opt_outs (
        session_id TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, git_dir, repo, branch, pr_number),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reminder_batches (
        batch_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        subscription_id TEXT UNIQUE,
        reminder_text TEXT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        max_event_seq INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY(subscription_id) REFERENCES session_subscriptions(subscription_id) ON DELETE CASCADE
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
        state TEXT NOT NULL DEFAULT 'stopped',
        idle_deadline_at INTEGER,
        terminal_at INTEGER,
        next_eligible_poll_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER,
        last_failure_message TEXT,
        rate_limit_reset_at INTEGER,
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
        dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        priority TEXT NOT NULL,
        summary TEXT NOT NULL,
        reference_link TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(repo, pr_number, dedupe_key)
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
    `);

		const sessionColumns = this.db
			.prepare(`PRAGMA table_info(sessions)`)
			.all() as Array<{ name: string }>;
		if (
			!sessionColumns.some(
				(column) => column.name === "last_delivered_event_seq",
			)
		) {
			this.db.exec(
				`ALTER TABLE sessions ADD COLUMN last_delivered_event_seq INTEGER NOT NULL DEFAULT 0`,
			);
		}

		this.db
			.prepare(
				`INSERT OR IGNORE INTO session_subscriptions (subscription_id, session_id, repo, pr_number, source, state, last_delivered_event_seq, created_at, updated_at)
				 SELECT 'legacy:' || session_id || ':' || repo || ':' || pr_number,
				        session_id, repo, pr_number, 'automatic', 'active', last_delivered_event_seq, created_at, updated_at
				 FROM sessions WHERE pr_number IS NOT NULL`,
			)
			.run();

		const prWatcherColumns = this.db
			.prepare(`PRAGMA table_info(pr_watchers)`)
			.all() as Array<{ name: string }>;
		const ensurePrWatcherColumn = (name: string, definition: string) => {
			if (!prWatcherColumns.some((column) => column.name === name)) {
				this.db.exec(`ALTER TABLE pr_watchers ADD COLUMN ${name} ${definition}`);
			}
		};
		ensurePrWatcherColumn("state", "TEXT NOT NULL DEFAULT 'stopped'");
		ensurePrWatcherColumn("idle_deadline_at", "INTEGER");
		ensurePrWatcherColumn("terminal_at", "INTEGER");
		ensurePrWatcherColumn("next_eligible_poll_at", "INTEGER");
		ensurePrWatcherColumn("consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
		ensurePrWatcherColumn("last_failure_at", "INTEGER");
		ensurePrWatcherColumn("last_failure_message", "TEXT");
		ensurePrWatcherColumn("rate_limit_reset_at", "INTEGER");
		this.db.exec(
			`UPDATE pr_watchers
			 SET state = 'warming_up'
			 WHERE active_session_count > 0 AND state = 'stopped'`,
		);

		const reminderColumns = this.db
			.prepare(`PRAGMA table_info(reminder_batches)`)
			.all() as Array<{ name: string }>;
		if (!reminderColumns.some((column) => column.name === "max_event_seq")) {
			this.db.exec(`ALTER TABLE reminder_batches ADD COLUMN max_event_seq INTEGER`);
		}
		if (!reminderColumns.some((column) => column.name === "subscription_id")) {
			this.db.exec(`
				CREATE TABLE reminder_batches_next (
					batch_id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					subscription_id TEXT UNIQUE,
					reminder_text TEXT NOT NULL,
					events_json TEXT NOT NULL,
					state TEXT NOT NULL,
					max_event_seq INTEGER,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
					FOREIGN KEY(subscription_id) REFERENCES session_subscriptions(subscription_id) ON DELETE CASCADE
				);
				INSERT INTO reminder_batches_next (batch_id, session_id, subscription_id, reminder_text, events_json, state, max_event_seq, created_at, updated_at)
				SELECT reminder_batches.batch_id, reminder_batches.session_id,
				       session_subscriptions.subscription_id, reminder_batches.reminder_text,
				       reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq,
				       reminder_batches.created_at, reminder_batches.updated_at
				FROM reminder_batches
				LEFT JOIN sessions ON sessions.session_id = reminder_batches.session_id
				LEFT JOIN session_subscriptions
				  ON session_subscriptions.session_id = reminder_batches.session_id
				 AND session_subscriptions.repo = sessions.repo
				 AND session_subscriptions.pr_number = sessions.pr_number;
				DROP TABLE reminder_batches;
				ALTER TABLE reminder_batches_next RENAME TO reminder_batches;
			`);
		}

		// Rename pr_events.detail_file_path -> reference_link. The legacy name
		// implied a local file path, but the column actually stores either a
		// local detail-file path or a GitHub URL depending on the event kind.
		// SQLite >= 3.25 supports RENAME COLUMN; this codebase already requires
		// a Node version that bundles a newer SQLite.
		const prEventColumns = this.db
			.prepare(`PRAGMA table_info(pr_events)`)
			.all() as Array<{ name: string }>;
		if (
			prEventColumns.some((column) => column.name === "detail_file_path") &&
			!prEventColumns.some((column) => column.name === "reference_link")
		) {
			this.db.exec(
				`ALTER TABLE pr_events RENAME COLUMN detail_file_path TO reference_link`,
			);
		}

		const prEventIndexes = this.db
			.prepare(`PRAGMA index_list(pr_events)`)
			.all() as Array<{ name: string; unique: number }>;
		const hasScopedEventUniqueness = prEventIndexes.some((index) => {
			if (index.unique !== 1) return false;
			const columns = this.db
				.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
				.all(index.name) as Array<{ name: string }>;
			return columns.map((column) => column.name).join(",") === "repo,pr_number,dedupe_key";
		});
		if (!hasScopedEventUniqueness) {
			const previousSequence = (this.db
				.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'pr_events'`)
				.get() as { seq: number } | undefined)?.seq;
			this.transaction(() => {
				this.db.exec(`
					CREATE TABLE pr_events_next (
						seq INTEGER PRIMARY KEY AUTOINCREMENT,
						repo TEXT NOT NULL,
						pr_number INTEGER NOT NULL,
						dedupe_key TEXT NOT NULL,
						kind TEXT NOT NULL,
						priority TEXT NOT NULL,
						summary TEXT NOT NULL,
						reference_link TEXT,
						payload_json TEXT NOT NULL,
						created_at INTEGER NOT NULL,
						UNIQUE(repo, pr_number, dedupe_key)
					);
					INSERT INTO pr_events_next
						(seq, repo, pr_number, dedupe_key, kind, priority, summary, reference_link, payload_json, created_at)
					SELECT seq, repo, pr_number, dedupe_key, kind, priority, summary, reference_link, payload_json, created_at
					FROM pr_events ORDER BY seq;
					DROP TABLE pr_events;
					ALTER TABLE pr_events_next RENAME TO pr_events;
				`);
				if (previousSequence !== undefined) {
					this.db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'pr_events'`).run();
					this.db
						.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('pr_events', ?)`)
						.run(previousSequence);
				}
			});
		}
	}
}

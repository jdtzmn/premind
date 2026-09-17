import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	PREMIND_CLIENT_LEASE_TTL_MS,
	PREMIND_COORDINATOR_LEASE_TTL_MS,
	PREMIND_DAEMON_LEASE_TTL_MS,
	PREMIND_CLOSED_SESSION_RETENTION_MS,
	PREMIND_DB_PATH,
	PREMIND_DATABASE_BUSY_TIMEOUT_MS,
	PREMIND_PR_STREAM_RETENTION_MS,
	PREMIND_REMINDER_HANDOFF_STALE_MS,
	PREMIND_STATE_DIR,
	PREMIND_SUBSCRIPTION_RETENTION_MS,
} from "../../shared/constants.ts";
import type {
	AckReminderPayload,
	AckReminderBundlePayload,
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
import {
	renderReminder,
	type RenderedReminderEvent,
} from "../reminders/render-reminder.ts";
import {
	createReminderHandoffActor,
	eventForReminderState,
	type ReminderHandoffState,
} from "../reminders/reminder-handoff-machine.ts";
import type { PrWatcherState } from "../watchers/pr-watcher-machine.ts";

type SessionRow = {
	session_id: string;
	host: "opencode" | "pi" | "claude";
	host_session_id: string;
	client_id: string;
	repo: string;
	branch: string;
	pr_number: number | null;
	is_primary: number;
	status: "active" | "paused" | "detached" | "closed";
	busy_state: "busy" | "idle";
	last_delivered_event_seq: number;
	last_activity_at: number;
};

export type SessionLeaseToken = {
	sessionId: string;
	ownerInstanceId: string;
	generation: number;
	clientIncarnationNonce: string;
	leaseToken: string;
	claimedAt: number;
	expiresAt: number;
};

export type SessionLeaseClaim = Pick<
	SessionLeaseToken,
	"sessionId" | "ownerInstanceId" | "clientIncarnationNonce"
>;

type SessionLeaseRow = {
	session_id: string;
	owner_instance_id: string | null;
	generation: number;
	client_incarnation_nonce: string | null;
	lease_token_hash: string | null;
	expires_at: number | null;
};

export type DaemonInstanceLeaseToken = {
	instanceId: string;
	incarnationNonce: string;
	storageEpoch: number;
	generation: number;
	expiresAt: number;
};

export type CoordinatorLeaseToken = {
	resourceKey: "background-coordinator";
	ownerInstanceId: string;
	ownerGeneration: number;
	storageEpoch: number;
	generation: number;
	expiresAt: number;
};

type DaemonInstanceLeaseRow = {
	instance_id: string;
	incarnation_nonce: string;
	storage_epoch: number;
	generation: number;
	expires_at: number;
};

type CoordinatorLeaseRow = {
	resource_key: "background-coordinator";
	owner_instance_id: string | null;
	owner_generation: number | null;
	storage_epoch: number;
	generation: number;
	lease_expires_at: number | null;
};

export type SubscriptionSource = "automatic" | "manual";
export type SubscriptionOwnership = "self" | "foreign" | "unknown";
export type SubscriptionPolicy = "actionable" | "observe-only";
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
	ownership: SubscriptionOwnership;
	policy: SubscriptionPolicy;
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
	handoff_id: string | null;
	handoff_size: number | null;
	repo?: string | null;
	pr_number?: number | null;
	source?: SubscriptionSource | null;
};

export type ReminderBatchRecord = Omit<ReminderBatch, "subscriptionId"> & {
	state: ReminderHandoffState;
	subscriptionId: string | null;
	maxEventSeq: number | null;
	handoffId: string | null;
	handoffSize: number | null;
};

export type HandoffExecutionOwner = {
	ownerInstanceId: string;
	sessionGeneration: number;
};

export type HandoffExecutionToken = HandoffExecutionOwner & {
	handoffId: string;
	sessionId: string;
	executionGeneration: number;
	expiresAt: number;
};

export type ReminderBundleClaim = {
	handoffId: string;
	executionGeneration: number;
	batches: ReminderBatch[];
};

type EventRow = {
	seq: number;
	kind: string;
	priority: "high" | "medium" | "low";
	summary: string;
	reference_link: string | null;
	payload_json: string;
};

type ReminderTarget = {
	repo: string;
	prNumber?: number;
	source?: SubscriptionSource;
	policy?: SubscriptionPolicy;
	worktreeMatchesTarget?: boolean;
};


const ownershipFor = (authorLogin: string | null | undefined, viewerLogin: string | null | undefined): SubscriptionOwnership => {
  if (!authorLogin || !viewerLogin) return "unknown";
  return authorLogin.toLowerCase() === viewerLogin.toLowerCase() ? "self" : "foreign";
};
type ReminderEventWindow = {
	sourceEventIds: number[];
	maximumEventSequence: number;
};

function busyTimeoutPragma(timeoutMs: number): string {
	switch (timeoutMs) {
		case 5_000:
			return "PRAGMA busy_timeout = 5000";
		default:
			throw new Error(`Unsupported SQLite busy timeout: ${timeoutMs}`);
	}
}

const hashLeaseToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const sessionLeaseBindings = (token: SessionLeaseToken, now: number) => ({
	sessionId: token.sessionId,
	ownerInstanceId: token.ownerInstanceId,
	generation: token.generation,
	clientIncarnationNonce: token.clientIncarnationNonce,
	leaseTokenHash: hashLeaseToken(token.leaseToken),
	now,
});

export class StateStore {
	private readonly db: DatabaseSync;
	private readonly detailFiles = new DetailFileWriter();
	private lastReapAt: number | null = null;
	private lastReapCount = 0;

	constructor(dbPath = PREMIND_DB_PATH) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec(busyTimeoutPragma(PREMIND_DATABASE_BUSY_TIMEOUT_MS));
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

	getStorageEpoch(): number {
		const row = this.db
			.prepare(`SELECT storage_epoch FROM storage_metadata WHERE singleton = 1`)
			.get() as { storage_epoch: number };
		return row.storage_epoch;
	}

	claimDaemonInstanceLease(
		claim: Pick<DaemonInstanceLeaseToken, "instanceId" | "incarnationNonce"> & {
			storageEpoch?: number;
		},
		now = Date.now(),
	): DaemonInstanceLeaseToken {
		return this.transaction(() => {
			const storageEpoch = this.getStorageEpoch();
			if (claim.storageEpoch !== undefined && claim.storageEpoch !== storageEpoch) {
				throw new Error(`STORAGE_EPOCH_MOVED: ${storageEpoch}`);
			}
			const existing = this.db
				.prepare(`SELECT * FROM daemon_instance_leases WHERE instance_id = ?`)
				.get(claim.instanceId) as DaemonInstanceLeaseRow | undefined;
			const sameIncarnation =
				existing?.incarnation_nonce === claim.incarnationNonce &&
				existing.storage_epoch === storageEpoch &&
				existing.expires_at > now;
			const expiresAt = now + PREMIND_DAEMON_LEASE_TTL_MS;
			if (sameIncarnation) {
				this.db.prepare(`UPDATE daemon_instance_leases SET expires_at = ? WHERE instance_id = ?`)
					.run(expiresAt, claim.instanceId);
				return {
					instanceId: claim.instanceId,
					incarnationNonce: claim.incarnationNonce,
					storageEpoch,
					generation: existing.generation,
					expiresAt,
				};
			}
			const generationRow = this.db
				.prepare(`UPDATE storage_metadata SET daemon_generation = daemon_generation + 1 WHERE singleton = 1 RETURNING daemon_generation`)
				.get() as { daemon_generation: number };
			this.db.prepare(
				`INSERT INTO daemon_instance_leases (instance_id, incarnation_nonce, storage_epoch, generation, expires_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(instance_id) DO UPDATE SET
				 incarnation_nonce = excluded.incarnation_nonce, storage_epoch = excluded.storage_epoch,
				 generation = excluded.generation, expires_at = excluded.expires_at`,
			).run(claim.instanceId, claim.incarnationNonce, storageEpoch, generationRow.daemon_generation, expiresAt);
			return {
				instanceId: claim.instanceId,
				incarnationNonce: claim.incarnationNonce,
				storageEpoch,
				generation: generationRow.daemon_generation,
				expiresAt,
			};
		});
	}

	validateDaemonInstanceLease(token: DaemonInstanceLeaseToken, now = Date.now()): boolean {
		return this.db.prepare(
			`SELECT 1 FROM daemon_instance_leases
			 WHERE instance_id = :instanceId AND incarnation_nonce = :incarnationNonce
			 AND storage_epoch = :storageEpoch AND generation = :generation AND expires_at > :now`,
		).get({
			instanceId: token.instanceId,
			incarnationNonce: token.incarnationNonce,
			storageEpoch: token.storageEpoch,
			generation: token.generation,
			now,
		}) !== undefined;
	}

	renewDaemonInstanceLease(
		token: DaemonInstanceLeaseToken,
		now = Date.now(),
	): DaemonInstanceLeaseToken | false {
		const expiresAt = now + PREMIND_DAEMON_LEASE_TTL_MS;
		const result = this.db.prepare(
			`UPDATE daemon_instance_leases SET expires_at = :expiresAt
			 WHERE instance_id = :instanceId AND incarnation_nonce = :incarnationNonce
			 AND storage_epoch = :storageEpoch AND generation = :generation AND expires_at > :now`,
		).run({ ...token, expiresAt, now });
		return (result.changes as number) === 1 ? { ...token, expiresAt } : false;
	}

	releaseDaemonInstanceLease(token: DaemonInstanceLeaseToken, now = Date.now()): boolean {
		const result = this.db.prepare(
			`UPDATE daemon_instance_leases SET expires_at = :now
			 WHERE instance_id = :instanceId AND incarnation_nonce = :incarnationNonce
			 AND storage_epoch = :storageEpoch AND generation = :generation AND expires_at > :now`,
		).run({
			instanceId: token.instanceId,
			incarnationNonce: token.incarnationNonce,
			storageEpoch: token.storageEpoch,
			generation: token.generation,
			now,
		});
		return (result.changes as number) === 1;
	}

	claimCoordinatorLease(
		daemon: DaemonInstanceLeaseToken,
		now = Date.now(),
	): CoordinatorLeaseToken {
		return this.transaction(() => {
			if (!this.validateDaemonInstanceLease(daemon, now)) {
				throw new Error(`DAEMON_MOVED: ${daemon.instanceId}`);
			}
			const current = this.db.prepare(
				`SELECT * FROM coordinator_leases WHERE resource_key = 'background-coordinator'`,
			).get() as CoordinatorLeaseRow;
			const active = current.owner_instance_id !== null && current.lease_expires_at !== null && current.lease_expires_at > now;
			const sameOwner = active && current.owner_instance_id === daemon.instanceId && current.owner_generation === daemon.generation;
			if (active && !sameOwner) throw new Error(`COORDINATOR_BUSY: ${current.owner_instance_id}`);
			const generation = sameOwner ? current.generation : current.generation + 1;
			const expiresAt = now + PREMIND_COORDINATOR_LEASE_TTL_MS;
			this.db.prepare(
				`UPDATE coordinator_leases SET owner_instance_id = ?, owner_generation = ?, storage_epoch = ?, generation = ?, lease_expires_at = ?
				 WHERE resource_key = 'background-coordinator'`,
			).run(daemon.instanceId, daemon.generation, daemon.storageEpoch, generation, expiresAt);
			return { resourceKey: "background-coordinator", ownerInstanceId: daemon.instanceId, ownerGeneration: daemon.generation, storageEpoch: daemon.storageEpoch, generation, expiresAt };
		});
	}

	renewCoordinatorLease(
		token: CoordinatorLeaseToken,
		now = Date.now(),
	): CoordinatorLeaseToken | false {
		const expiresAt = now + PREMIND_COORDINATOR_LEASE_TTL_MS;
		const result = this.db.prepare(
			`UPDATE coordinator_leases SET lease_expires_at = :expiresAt
			 WHERE resource_key = :resourceKey AND owner_instance_id = :ownerInstanceId
			 AND owner_generation = :ownerGeneration AND storage_epoch = :storageEpoch
			 AND generation = :generation AND lease_expires_at > :now`,
		).run({
			resourceKey: token.resourceKey,
			ownerInstanceId: token.ownerInstanceId,
			ownerGeneration: token.ownerGeneration,
			storageEpoch: token.storageEpoch,
			generation: token.generation,
			expiresAt,
			now,
		});
		return (result.changes as number) === 1 ? { ...token, expiresAt } : false;
	}

	releaseCoordinatorLease(token: CoordinatorLeaseToken, now = Date.now()): boolean {
		const result = this.db.prepare(
			`UPDATE coordinator_leases SET owner_instance_id = NULL, owner_generation = NULL, lease_expires_at = NULL
			 WHERE resource_key = :resourceKey AND owner_instance_id = :ownerInstanceId
			 AND owner_generation = :ownerGeneration AND storage_epoch = :storageEpoch
			 AND generation = :generation AND lease_expires_at > :now`,
		).run({
			resourceKey: token.resourceKey,
			ownerInstanceId: token.ownerInstanceId,
			ownerGeneration: token.ownerGeneration,
			storageEpoch: token.storageEpoch,
			generation: token.generation,
			now,
		});
		return (result.changes as number) === 1;
	}



	transferCoordinatorLease(
		current: CoordinatorLeaseToken,
		nextDaemon: DaemonInstanceLeaseToken,
		now = Date.now(),
	): CoordinatorLeaseToken {
		return this.transaction(() => {
			if (!this.validateDaemonInstanceLease(nextDaemon, now)) throw new Error(`DAEMON_MOVED: ${nextDaemon.instanceId}`);
			const generation = current.generation + 1;
			const expiresAt = now + PREMIND_COORDINATOR_LEASE_TTL_MS;
			const result = this.db.prepare(
				`UPDATE coordinator_leases SET owner_instance_id = :nextOwner, owner_generation = :nextOwnerGeneration,
				 storage_epoch = :nextStorageEpoch, generation = :nextGeneration, lease_expires_at = :expiresAt
				 WHERE resource_key = :resourceKey AND owner_instance_id = :ownerInstanceId
				 AND owner_generation = :ownerGeneration AND storage_epoch = :storageEpoch
				 AND generation = :generation AND lease_expires_at > :now`,
			).run({ ...current, nextOwner: nextDaemon.instanceId, nextOwnerGeneration: nextDaemon.generation, nextStorageEpoch: nextDaemon.storageEpoch, nextGeneration: generation, expiresAt, now });
			if ((result.changes as number) !== 1) throw new Error("COORDINATOR_MOVED: background-coordinator");
			return { resourceKey: "background-coordinator", ownerInstanceId: nextDaemon.instanceId, ownerGeneration: nextDaemon.generation, storageEpoch: nextDaemon.storageEpoch, generation, expiresAt };
		});
	}

	withCoordinatorLease<T>(
		token: CoordinatorLeaseToken,
		operation: () => T,
		now = Date.now(),
	): T {
		return this.transaction(() => {
			const valid = this.db.prepare(
				`SELECT 1 FROM coordinator_leases WHERE resource_key = :resourceKey
				 AND owner_instance_id = :ownerInstanceId AND owner_generation = :ownerGeneration
				 AND storage_epoch = :storageEpoch AND generation = :generation AND lease_expires_at > :now`,
			).get({
				resourceKey: token.resourceKey,
				ownerInstanceId: token.ownerInstanceId,
				ownerGeneration: token.ownerGeneration,
				storageEpoch: token.storageEpoch,
				generation: token.generation,
				now,
			});
			if (!valid) throw new Error("COORDINATOR_MOVED: background-coordinator");
			return operation();
		});
	}


	claimSessionLease(
		claim: SessionLeaseClaim,
		now = Date.now(),
	): SessionLeaseToken {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db
				.prepare(`SELECT * FROM session_daemon_leases WHERE session_id = ?`)
				.get(claim.sessionId) as SessionLeaseRow | undefined;
			const active =
				existing !== undefined &&
				existing.owner_instance_id !== null &&
				existing.expires_at !== null &&
				existing.expires_at > now;
			const sameClaimant =
				active &&
				existing.owner_instance_id === claim.ownerInstanceId &&
				existing.client_incarnation_nonce === claim.clientIncarnationNonce;
			if (active && !sameClaimant) {
				throw new Error(`SESSION_BUSY: ${claim.sessionId}`);
			}

			const generation = sameClaimant
				? existing.generation
				: (existing?.generation ?? 0) + 1;
			const leaseToken = randomUUID();
			const expiresAt = now + PREMIND_CLIENT_LEASE_TTL_MS;
			this.db
				.prepare(
					`INSERT INTO session_daemon_leases
					 (session_id, owner_instance_id, generation, client_incarnation_nonce, lease_token_hash, expires_at)
					 VALUES (:sessionId, :ownerInstanceId, :generation, :clientIncarnationNonce, :leaseTokenHash, :expiresAt)
					 ON CONFLICT(session_id) DO UPDATE SET
					   owner_instance_id = excluded.owner_instance_id,
					   generation = excluded.generation,
					   client_incarnation_nonce = excluded.client_incarnation_nonce,
					   lease_token_hash = excluded.lease_token_hash,
					   expires_at = excluded.expires_at`,
				)
				.run({
					...claim,
					generation,
					leaseTokenHash: hashLeaseToken(leaseToken),
					expiresAt,
				});
			this.db.exec("COMMIT");
			return { ...claim, generation, leaseToken, claimedAt: now, expiresAt };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	validateSessionLease(token: SessionLeaseToken, now = Date.now()): boolean {
		return (
			this.db
				.prepare(
					`SELECT 1 FROM session_daemon_leases
					 WHERE session_id = :sessionId
					   AND owner_instance_id = :ownerInstanceId
					   AND generation = :generation
					   AND client_incarnation_nonce = :clientIncarnationNonce
					   AND lease_token_hash = :leaseTokenHash
					   AND expires_at > :now`,
				)
				.get(sessionLeaseBindings(token, now)) !== undefined
		);
	}

	withSessionLease<T>(
		token: SessionLeaseToken,
		operation: () => T,
		now = Date.now(),
	): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!this.validateSessionLease(token, now)) {
				throw new Error(`SESSION_MOVED: ${token.sessionId}`);
			}
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}


	renewSessionLease(
		token: SessionLeaseToken,
		now = Date.now(),
	): SessionLeaseToken | false {
		const expiresAt = now + PREMIND_CLIENT_LEASE_TTL_MS;
		const result = this.db
			.prepare(
				`UPDATE session_daemon_leases SET expires_at = :expiresAt
				 WHERE session_id = :sessionId
				   AND owner_instance_id = :ownerInstanceId
				   AND generation = :generation
				   AND client_incarnation_nonce = :clientIncarnationNonce
				   AND lease_token_hash = :leaseTokenHash
				   AND expires_at > :now`,
			)
			.run({ ...sessionLeaseBindings(token, now), expiresAt });
		return (result.changes as number) === 1
			? { ...token, expiresAt }
			: false;
	}

	transferSessionLease(
		current: SessionLeaseToken,
		nextOwner: Omit<SessionLeaseClaim, "sessionId">,
		now = Date.now(),
	): SessionLeaseToken {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const generation = current.generation + 1;
			const leaseToken = randomUUID();
			const expiresAt = now + PREMIND_CLIENT_LEASE_TTL_MS;
			const result = this.db
				.prepare(
					`UPDATE session_daemon_leases
					 SET owner_instance_id = :nextOwnerInstanceId,
					     generation = :nextGeneration,
					     client_incarnation_nonce = :nextClientIncarnationNonce,
					     lease_token_hash = :nextLeaseTokenHash,
					     expires_at = :expiresAt
					 WHERE session_id = :sessionId
					   AND owner_instance_id = :ownerInstanceId
					   AND generation = :generation
					   AND client_incarnation_nonce = :clientIncarnationNonce
					   AND lease_token_hash = :leaseTokenHash
					   AND expires_at > :now`,
				)
				.run({
					...sessionLeaseBindings(current, now),
					nextOwnerInstanceId: nextOwner.ownerInstanceId,
					nextGeneration: generation,
					nextClientIncarnationNonce: nextOwner.clientIncarnationNonce,
					nextLeaseTokenHash: hashLeaseToken(leaseToken),
					expiresAt,
				});
			if ((result.changes as number) !== 1) {
				throw new Error(`SESSION_MOVED: ${current.sessionId}`);
			}
			this.db.exec("COMMIT");
			return {
				sessionId: current.sessionId,
				...nextOwner,
				generation,
				leaseToken,
				claimedAt: now,
				expiresAt,
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}


	releaseSessionLease(token: SessionLeaseToken, now = Date.now()): boolean {
		const result = this.db
			.prepare(
				`UPDATE session_daemon_leases
				 SET owner_instance_id = NULL, client_incarnation_nonce = NULL,
				     lease_token_hash = NULL, expires_at = NULL
				 WHERE session_id = :sessionId
				   AND owner_instance_id = :ownerInstanceId
				   AND generation = :generation
				   AND client_incarnation_nonce = :clientIncarnationNonce
				   AND lease_token_hash = :leaseTokenHash
				   AND expires_at > :now`,
			)
			.run(sessionLeaseBindings(token, now));
		return (result.changes as number) === 1;
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

	recoverFromRestartAsCoordinator(
		coordinator: CoordinatorLeaseToken,
		now = Date.now(),
	) {
		return this.withCoordinatorLease(coordinator, () => this.recoverFromRestart(now), now);
	}


	recoverFromRestart(now = Date.now()) {
		// Record retained state before fencing every process-owned session.
		const sessions = this.countActiveSessions();
		const branchWatchers = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM branch_watchers WHERE active_session_count > 0`,
				)
				.get() as { count: number }
		).count;
		const prWatchers = this.countActiveWatchers();

		// Previous-process owners cannot survive a daemon restart. Preserve their
		// durable state, but make it ineligible for delivery until reattachment.
		this.db
			.prepare(
				`UPDATE sessions SET status = 'detached', busy_state = 'idle', updated_at = :now
				 WHERE host IN ('opencode', 'pi') AND status IN ('active', 'paused')`,
			)
			.run({ now });
		this.db
			.prepare(
				`UPDATE session_daemon_leases
				 SET owner_instance_id = NULL, client_incarnation_nonce = NULL,
				     lease_token_hash = NULL, expires_at = NULL
				 WHERE owner_instance_id IS NOT NULL`,
			)
			.run();
		const deletedClients = this.db.prepare(`DELETE FROM client_leases`).run();

		// A crash leaves handed-off delivery uncertain. Preserve the durable batch
		// and its cursor, but make it explicitly retryable after reattachment.
		const resetBatches = this.db
			.prepare(
				`UPDATE reminder_batches SET state = 'failed', updated_at = :now
				 WHERE state = 'handed_off'`,
			)
			.run({ now });
		this.refreshWatcherCounts(now);

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
		return (
			this.db
				.prepare(`SELECT 1 FROM client_leases WHERE client_id = ?`)
				.get(clientId) !== undefined
		);
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
          INSERT INTO sessions (session_id, host, host_session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
          VALUES (:sessionId, :host, :hostSessionId, :clientId, :repo, :branch, NULL, :isPrimary, :status, :busyState, 0, :now, :now, :now)
          ON CONFLICT(session_id) DO UPDATE SET
            host = excluded.host,
            host_session_id = excluded.host_session_id,
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
					host: payload.host ?? "opencode",
					hostSessionId: payload.hostSessionId ?? payload.sessionId,
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
		return this.transaction(() => {
			const existing = this.getSession(payload.sessionId);
			const status = payload.paused ? "paused" : "active";
			const contextChanged =
				existing !== undefined &&
				(existing.repo !== payload.repo || existing.branch !== payload.branch);
			const watcher = this.db
				.prepare(
					`SELECT pr_number FROM branch_watchers WHERE repo = :repo AND branch = :branch`,
				)
				.get({ repo: payload.repo, branch: payload.branch }) as
				| {
						pr_number: number | null;
				  }
				| undefined;
			const attachedPrNumber = watcher?.pr_number ?? null;
			const highWaterCursor =
				attachedPrNumber === null
					? 0
					: ((
							this.db
								.prepare(
									`SELECT MAX(seq) AS maxSeq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`,
								)
								.get({
									repo: payload.repo,
									prNumber: attachedPrNumber,
								}) as { maxSeq: number | null }
						).maxSeq ?? 0);
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
						 SET host = :host,
						     host_session_id = :hostSessionId,
						     client_id = :clientId,
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
						host: payload.host ?? "opencode",
						hostSessionId: payload.hostSessionId ?? payload.sessionId,
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
						`INSERT INTO sessions (session_id, host, host_session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
						 VALUES (:sessionId, :host, :hostSessionId, :clientId, :repo, :branch, :prNumber, :isPrimary, :status, :busyState, :cursor, :now, :now, :now)`,
					)
					.run({
						clientId: payload.clientId,
						host: payload.host ?? "opencode",
						hostSessionId: payload.hostSessionId ?? payload.sessionId,
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
			// Preserve the main-compatible response shape without closing peer sessions.
			return { created: !existing, superseded: 0 };
		});
	}

	updateSessionState(payload: UpdateSessionStatePayload, now = Date.now()) {
		const current = this.getSession(payload.sessionId);
		if (!current) return { updated: false, revived: false };
		const revived =
			(current.status === "closed" || current.status === "detached") &&
			!!payload.busyState;
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

	suspendClaudeSession(sessionId: string, now = Date.now()): boolean {
		const session = this.getSession(sessionId);
		if (!session || session.host !== "claude") return false;
		this.db
			.prepare(
				`UPDATE sessions
				 SET status = 'closed', busy_state = 'idle', updated_at = :now
				 WHERE session_id = :sessionId`,
			)
			.run({ sessionId, now });
		this.refreshWatcherCounts(now);
		return true;
	}

	unregisterSession(sessionId: string, now = Date.now()): boolean {
		const result = this.db
			.prepare(
				`UPDATE sessions
				 SET status = 'detached', busy_state = 'idle', updated_at = :now
				 WHERE session_id = :sessionId AND status != 'closed'
				   AND NOT EXISTS (
				     SELECT 1 FROM session_daemon_leases
				     WHERE session_id = :sessionId AND expires_at > :now
				   )`,
			)
			.run({ sessionId, now });
		if ((result.changes as number) === 1) this.refreshWatcherCounts(now);
		return (result.changes as number) === 1;
	}

	deleteSession(sessionId: string, now = Date.now()): boolean {
		const result = this.db
			.prepare(
				`UPDATE sessions
				 SET status = 'closed', busy_state = 'idle', updated_at = :now
				 WHERE session_id = :sessionId AND status != 'closed'`,
			)
			.run({ sessionId, now });
		if ((result.changes as number) === 0) return false;
		this.db
			.prepare(
				`UPDATE session_daemon_leases
				 SET owner_instance_id = NULL, client_incarnation_nonce = NULL,
				     lease_token_hash = NULL, expires_at = NULL
				 WHERE session_id = ?`,
			)
			.run(sessionId);
		this.refreshWatcherCounts(now);
		return true;
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
			.get(sessionId) as
			| {
					session_id: string;
					root: string;
					git_dir: string;
					repo: string;
					branch: string | null;
					head_sha: string;
					state: string;
					updated_at: number;
			  }
			| undefined;
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
			if (binding.branch)
				this.ensureBranchWatcher(binding.repo, binding.branch, now);
			return activeBinding;
		});
	}

	upsertSubscription(
		input: {
			sessionId: string;
			repo: string;
			prNumber: number;
			source: SubscriptionSource;
		},
		now = Date.now(),
	): SessionSubscription {
		return this.transaction(() => {
			if (!this.getSession(input.sessionId)) {
				throw new Error(`Unknown session: ${input.sessionId}`);
			}
			this.db
				.prepare(
					`
					INSERT INTO session_subscriptions (subscription_id, session_id, repo, pr_number, source, ownership, policy, state, last_delivered_event_seq, created_at, updated_at)
					VALUES (:subscriptionId, :sessionId, :repo, :prNumber, :source, 'unknown', 'observe-only', 'active', 0, :now, :now)
					ON CONFLICT(session_id, repo, pr_number) DO UPDATE SET
						source = CASE WHEN session_subscriptions.source = 'manual' OR excluded.source = 'manual' THEN 'manual' ELSE 'automatic' END,
						ownership = CASE WHEN session_subscriptions.source = 'manual' OR excluded.source = 'manual' THEN 'unknown' ELSE session_subscriptions.ownership END,
						policy = CASE WHEN session_subscriptions.source = 'manual' OR excluded.source = 'manual' THEN 'observe-only' ELSE session_subscriptions.policy END,
						state = 'active',
						updated_at = excluded.updated_at
					`,
				)
				.run({ ...input, subscriptionId: randomUUID(), now });
			this.touchPrWatcher(input.repo, input.prNumber, now);
			return this.getSubscription(input.sessionId, input.repo, input.prNumber)!;
		});
	}

	reconcileSubscriptionPolicies(
		repo: string,
		prNumber: number,
		authorLogin: string | null | undefined,
		viewerLogin: string | null | undefined,
		now = Date.now(),
	): number {
		const ownership = ownershipFor(authorLogin, viewerLogin);
		const policy: SubscriptionPolicy = ownership === "self" ? "actionable" : "observe-only";
		return this.transaction(() => {
			const result = this.db.prepare(`
				UPDATE session_subscriptions
				SET ownership = :ownership, policy = :policy, updated_at = :now
				WHERE repo = :repo AND pr_number = :prNumber AND state = 'active'
				  AND (ownership != :ownership OR policy != :policy)
			`).run({ repo, prNumber, ownership, policy, now });
			if ((result.changes as number) > 0) {
				this.db.prepare(`
					DELETE FROM reminder_batches
					WHERE state != 'handed_off' AND subscription_id IN (
						SELECT subscription_id FROM session_subscriptions
						WHERE repo = :repo AND pr_number = :prNumber AND state = 'active'
					)
				`).run({ repo, prNumber });
			}
			return result.changes as number;
		});
	}

	getSubscription(
		sessionId: string,
		repo: string,
		prNumber: number,
	): SessionSubscription | null {
		const row = this.db
			.prepare(
				`SELECT * FROM session_subscriptions WHERE session_id = ? AND repo = ? AND pr_number = ?`,
			)
			.get(sessionId, repo, prNumber) as
			| {
					subscription_id: string;
					session_id: string;
					repo: string;
					pr_number: number;
					source: SubscriptionSource;
					ownership: SubscriptionOwnership;
					policy: SubscriptionPolicy;
					state: SubscriptionState;
					last_delivered_event_seq: number;
					updated_at: number;
			  }
			| undefined;
		return row ? this.toSubscription(row) : null;
	}

	getSubscriptionById(subscriptionId: string): SessionSubscription | null {
		const row = this.db
			.prepare(`SELECT * FROM session_subscriptions WHERE subscription_id = ?`)
			.get(subscriptionId) as
			| {
					subscription_id: string;
					session_id: string;
					repo: string;
					pr_number: number;
					source: SubscriptionSource;
					ownership: SubscriptionOwnership;
					policy: SubscriptionPolicy;
					state: SubscriptionState;
					last_delivered_event_seq: number;
					updated_at: number;
			  }
			| undefined;
		return row ? this.toSubscription(row) : null;
	}

	private toSubscription(row: {
		subscription_id: string;
		session_id: string;
		repo: string;
		pr_number: number;
		source: SubscriptionSource;
		ownership: SubscriptionOwnership;
		policy: SubscriptionPolicy;
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
			ownership: row.ownership,
			policy: row.policy,
			state: row.state,
			lastDeliveredEventSeq: row.last_delivered_event_seq,
			updatedAt: row.updated_at,
		};
	}

	listSessionSubscriptions(
		sessionId: string,
		state?: SubscriptionState,
	): SessionSubscription[] {
		const statement = state
			? this.db.prepare(
					`SELECT * FROM session_subscriptions WHERE session_id = :sessionId AND state = :state ORDER BY created_at ASC`,
				)
			: this.db.prepare(
					`SELECT * FROM session_subscriptions WHERE session_id = :sessionId ORDER BY created_at ASC`,
				);
		const rows = (
			state ? statement.all({ sessionId, state }) : statement.all({ sessionId })
		) as Array<{
			subscription_id: string;
			session_id: string;
			repo: string;
			pr_number: number;
			source: SubscriptionSource;
			ownership: SubscriptionOwnership;
			policy: SubscriptionPolicy;
			state: SubscriptionState;
			last_delivered_event_seq: number;
			updated_at: number;
		}>;
		return rows.map((row) => ({
			subscriptionId: row.subscription_id,
			sessionId: row.session_id,
			repo: row.repo,
			prNumber: row.pr_number,
			source: row.source,
			ownership: row.ownership,
			policy: row.policy,
			state: row.state,
			lastDeliveredEventSeq: row.last_delivered_event_seq,
			updatedAt: row.updated_at,
		}));
	}

	listActiveSubscriptionsForPr(
		repo: string,
		prNumber: number,
	): SessionSubscription[] {
		const rows = this.db
			.prepare(
				`SELECT session_subscriptions.*
				 FROM session_subscriptions
				 INNER JOIN sessions ON sessions.session_id = session_subscriptions.session_id
				 WHERE session_subscriptions.repo = :repo
				   AND session_subscriptions.pr_number = :prNumber
				   AND session_subscriptions.state = 'active'
				   AND sessions.status IN ('active', 'paused')
				 ORDER BY session_subscriptions.created_at ASC`,
			)
			.all({ repo, prNumber }) as Array<{
			subscription_id: string;
			session_id: string;
			repo: string;
			pr_number: number;
			source: SubscriptionSource;
			ownership: SubscriptionOwnership;
			policy: SubscriptionPolicy;
			state: SubscriptionState;
			last_delivered_event_seq: number;
			updated_at: number;
		}>;
		return rows.map((row) => ({
			subscriptionId: row.subscription_id,
			sessionId: row.session_id,
			repo: row.repo,
			prNumber: row.pr_number,
			source: row.source,
			ownership: row.ownership,
			policy: row.policy,
			state: row.state,
			lastDeliveredEventSeq: row.last_delivered_event_seq,
			updatedAt: row.updated_at,
		}));
	}

	baselineAutomaticSubscription(
		input: { sessionId: string; repo: string; prNumber: number },
		now = Date.now(),
	): SessionSubscription {
		return this.transaction(() => {
			const existing = this.getSubscription(
				input.sessionId,
				input.repo,
				input.prNumber,
			);
			if (existing?.source === "manual") return existing;

			// A session that already held this subscription is re-attaching (every
			// `activateWorktree` deactivates automatic subscriptions, so this happens
			// on every session start). Keep its own cursor: baselining to the current
			// high-water mark would silently skip events it had queued but not yet
			// received. Only a genuinely new attachment starts at high water, so stale
			// history is still not dumped on a first subscribe. This reads and writes
			// one session's own cursor, so concurrent sessions stay independent.
			const row = this.db
				.prepare(
					`SELECT MAX(seq) AS max_seq FROM pr_events WHERE repo = :repo AND pr_number = :prNumber`,
				)
				.get({ repo: input.repo, prNumber: input.prNumber }) as
				| { max_seq: number | null }
				| undefined;
			const cursor = existing
				? existing.lastDeliveredEventSeq
				: (row?.max_seq ?? 0);
			const subscriptionId = existing?.subscriptionId ?? randomUUID();
			this.db
				.prepare(
					`INSERT INTO session_subscriptions (subscription_id, session_id, repo, pr_number, source, ownership, policy, state, last_delivered_event_seq, created_at, updated_at)
					 VALUES (:subscriptionId, :sessionId, :repo, :prNumber, 'automatic', 'self', 'actionable', 'active', :cursor, :now, :now)
					 ON CONFLICT(session_id, repo, pr_number) DO UPDATE SET
					   ownership = 'self',
					   policy = 'actionable',
					   state = 'active',
					   last_delivered_event_seq = :cursor,
					   updated_at = :now`
				)
				.run({ ...input, subscriptionId, cursor, now });
			this.touchPrWatcher(input.repo, input.prNumber, now);
			return this.getSubscription(input.sessionId, input.repo, input.prNumber)!;
		});
	}

	unsubscribe(
		sessionId: string,
		repo: string,
		prNumber: number,
		now = Date.now(),
	): boolean {
		return this.transaction(() => {
			const input = { sessionId, repo, prNumber, now };
			this.db
				.prepare(
					`DELETE FROM reminder_batches
					 WHERE subscription_id IN (
					   SELECT subscription_id FROM session_subscriptions
					   WHERE session_id = :sessionId AND repo = :repo AND pr_number = :prNumber
					 ) AND state != 'handed_off'`,
				)
				.run({ sessionId, repo, prNumber });
			const result = this.db
				.prepare(
					`UPDATE session_subscriptions SET state = 'unsubscribed', updated_at = :now WHERE session_id = :sessionId AND repo = :repo AND pr_number = :prNumber AND state = 'active'`,
				)
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
					 ) AND state != 'handed_off'`,
				)
				.run({ sessionId });
			const result = this.db
				.prepare(
					`UPDATE session_subscriptions SET state = 'unsubscribed', updated_at = :now WHERE session_id = :sessionId AND source = 'automatic' AND state = 'active'`,
				)
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
					`UPDATE reminder_batches SET canceled_at = :now, updated_at = :now
					 WHERE session_id = :sessionId AND subscription_id IS NULL
					   AND state = 'handed_off'`,
				)
				.run({ sessionId, now });
			this.db
				.prepare(
					`DELETE FROM reminder_batches
					 WHERE session_id = :sessionId AND subscription_id IS NULL
					   AND state != 'handed_off'`,
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
			.prepare(
				`UPDATE branch_watchers SET pr_number = NULL, updated_at = :now WHERE pr_number IS NOT NULL`,
			)
			.run({ now });
		return subscriptions.length;
	}

	recordAutomaticSubscriptionOptOut(
		input: {
			sessionId: string;
			gitDir: string;
			repo: string;
			branch: string;
			prNumber: number;
		},
		now = Date.now(),
	) {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO automatic_subscription_opt_outs (session_id, git_dir, repo, branch, pr_number, created_at)
				 VALUES (:sessionId, :gitDir, :repo, :branch, :prNumber, :now)`,
			)
			.run({ ...input, now });
	}

	hasAutomaticSubscriptionOptOut(input: {
		sessionId: string;
		gitDir: string;
		repo: string;
		branch: string;
		prNumber: number;
	}): boolean {
		return Boolean(
			this.db
				.prepare(
					`SELECT 1 FROM automatic_subscription_opt_outs WHERE session_id = :sessionId AND git_dir = :gitDir AND repo = :repo AND branch = :branch AND pr_number = :prNumber`,
				)
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
	 * Detaches active or paused sessions whose last_activity_at is older than
	 * the threshold without starting explicit-deletion retention.
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
				`UPDATE sessions SET status = 'detached', busy_state = 'idle', updated_at = :now
				 WHERE status IN ('active', 'paused') AND last_activity_at < :cutoff`,
			)
			.run({ now, cutoff });

		const reaped = result.changes as number;
		if (reaped > 0) this.refreshWatcherCounts(now);

		const oldestRow = this.db
			.prepare(
				`SELECT MIN(last_activity_at) AS oldest FROM sessions
				 WHERE status IN ('active', 'paused')`,
			)
			.get() as { oldest: number | null };
		const oldestAgeMs = oldestRow.oldest === null ? null : now - oldestRow.oldest;

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

	pruneClosedOrOrphanedSessions(
		now = Date.now(),
		retentionMs = PREMIND_CLOSED_SESSION_RETENTION_MS,
	) {
		// Compatibility entry point: lack of a live process lease no longer makes
		// durable session state orphaned. Only explicit deletion starts retention.
		const cutoff = now - retentionMs;
		const deletedBatches = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM reminder_batches
					 WHERE session_id IN (
					   SELECT session_id FROM sessions
					   WHERE status = 'closed' AND updated_at < :cutoff
					 )`,
				)
				.get({ cutoff }) as { count: number }
		).count;
		const deletedSessions = this.db
			.prepare(
				`DELETE FROM sessions
				 WHERE status = 'closed' AND updated_at < :cutoff`,
			)
			.run({ cutoff });
		return {
			sessions: deletedSessions.changes as number,
			reminderBatches: deletedBatches,
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
				.prepare(
					`DELETE FROM pr_snapshots WHERE (repo, pr_number) IN (${expiredStreams})`,
				)
				.run(parameters);
			const events = this.db
				.prepare(
					`DELETE FROM pr_events WHERE (repo, pr_number) IN (${expiredStreams})`,
				)
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
				.prepare(
					`DELETE FROM pr_watchers WHERE (repo, pr_number) IN (${expiredStreams})`,
				)
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
				`SELECT session_id, host, repo, branch, pr_number, status, busy_state, last_delivered_event_seq FROM sessions WHERE status != 'closed' ORDER BY updated_at DESC`,
			)
			.all() as Array<{
			session_id: string;
			host: "opencode" | "pi" | "claude";
			repo: string;
			branch: string;
			pr_number: number | null;
			status: "active" | "paused" | "detached" | "closed";
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
							.reduce(
								(count, subscription) => count + subscription.pendingEventCount,
								0,
							)
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
				host: session.host,
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

	private countPendingEvents(
		repo: string,
		prNumber: number,
		lastDeliveredEventSeq: number,
	) {
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
				`SELECT COUNT(*) AS count FROM sessions WHERE status IN ('active', 'paused')`,
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
				      WHERE session_subscriptions.state = 'active'
				        AND sessions.status IN ('active', 'paused')) +
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
				 WHERE sessions.status IN ('active', 'paused')
				   AND worktree_bindings.branch IS NOT NULL
				   AND worktree_bindings.state != 'detached_head'
				 UNION ALL
				 SELECT sessions.session_id, '' AS git_dir, sessions.repo, sessions.branch, branch_watchers.pr_number
				 FROM sessions
				 LEFT JOIN worktree_bindings ON worktree_bindings.session_id = sessions.session_id
				 LEFT JOIN branch_watchers
				   ON branch_watchers.repo = sessions.repo
				  AND branch_watchers.branch = sessions.branch
				 WHERE sessions.status IN ('active', 'paused')
				   AND worktree_bindings.session_id IS NULL
				 `,
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
				this.baselineAutomaticSubscription(
					{
						sessionId: session.session_id,
						repo,
						prNumber,
					},
					checkedAt,
				);
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
				   AND sessions.status IN ('active', 'paused')
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
		const rows = this.db
			.prepare(`SELECT * FROM pr_watchers ORDER BY created_at ASC`)
			.all() as Array<{
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
		return (
			this.listPrWatcherRecords().find(
				(record) => record.repo === repo && record.prNumber === prNumber,
			) ?? null
		);
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
          WHERE repo = :repo AND pr_number = :prNumber
            AND status IN ('active', 'paused')
        `,
			)
			.all({ repo, prNumber }) as SessionRow[];
	}

	listUndeliveredEvents(sessionId: string, limit = 20) {
		const subscriptions = this.listSessionSubscriptions(sessionId, "active");
		for (const subscription of subscriptions) {
			const events = this.listUndeliveredEventsForSubscription(
				subscription.subscriptionId,
				limit,
			);
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
				`SELECT seq, kind, priority, summary, reference_link, payload_json
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
		const session = this.getSession(sessionId);
		if (!session || session.status !== "active") return null;
		const record = this.getPendingReminderRecord(sessionId);
		return record ? this.refreshPendingReminder(record) : null;
	}

	claimHandoffExecution(
		handoffId: string,
		sessionId: string,
		owner: HandoffExecutionOwner,
		now = Date.now(),
	): HandoffExecutionToken {
		return this.transaction(() => {
			const existing = this.db.prepare(
				`SELECT owner_instance_id, session_generation, execution_generation, expires_at, settled_at
				 FROM reminder_handoff_execution_claims WHERE handoff_id = ?`,
			).get(handoffId) as {
				owner_instance_id: string;
				session_generation: number;
				execution_generation: number;
				expires_at: number;
				settled_at: number | null;
			} | undefined;
			if (existing?.settled_at !== null && existing?.settled_at !== undefined) {
				throw new Error(`HANDOFF_SETTLED: ${handoffId}`);
			}
			const active = existing !== undefined && existing.expires_at > now;
			const sameOwner = active &&
				existing.owner_instance_id === owner.ownerInstanceId &&
				existing.session_generation === owner.sessionGeneration;
			if (active && !sameOwner) throw new Error(`HANDOFF_BUSY: ${handoffId}`);
			const executionGeneration = sameOwner
				? existing.execution_generation
				: (existing?.execution_generation ?? 0) + 1;
			const expiresAt = now + PREMIND_REMINDER_HANDOFF_STALE_MS;
			this.db.prepare(
				`INSERT INTO reminder_handoff_execution_claims
				 (handoff_id, session_id, owner_instance_id, session_generation, execution_generation, expires_at, settled_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT(handoff_id) DO UPDATE SET
				 session_id = excluded.session_id, owner_instance_id = excluded.owner_instance_id,
				 session_generation = excluded.session_generation, execution_generation = excluded.execution_generation,
				 expires_at = excluded.expires_at, settled_at = NULL`,
			).run(handoffId, sessionId, owner.ownerInstanceId, owner.sessionGeneration, executionGeneration, expiresAt);
			return { handoffId, sessionId, ...owner, executionGeneration, expiresAt };
		});
	}

	validateHandoffExecution(token: HandoffExecutionToken, now = Date.now()): boolean {
		return this.db.prepare(
			`SELECT 1 FROM reminder_handoff_execution_claims
			 WHERE handoff_id = :handoffId AND session_id = :sessionId
			 AND owner_instance_id = :ownerInstanceId AND session_generation = :sessionGeneration
			 AND execution_generation = :executionGeneration AND expires_at > :now AND settled_at IS NULL`,
		).get({
			handoffId: token.handoffId,
			sessionId: token.sessionId,
			ownerInstanceId: token.ownerInstanceId,
			sessionGeneration: token.sessionGeneration,
			executionGeneration: token.executionGeneration,
			now,
		}) !== undefined;
	}


	/** Atomically claims every currently deliverable batch for a session. */
	claimReminderBundle(
		sessionId: string,
		now = Date.now(),
		owner: HandoffExecutionOwner = {
			ownerInstanceId: "legacy-singleton",
			sessionGeneration: 0,
		},
	): ReminderBundleClaim | null {
		return this.transaction(() => {
			const session = this.getSession(sessionId);
			if (!session || session.status !== "active") return null;
			this.expireStaleHandoffs(undefined, now);
			if (this.listInFlightReminderBatchRecords(sessionId).length > 0) return null;

			const batches = this.listPendingLegacyReminderBatchRecords(sessionId).flatMap(
				(record) => {
					const refreshed = this.refreshPendingReminder(record);
					return refreshed ? [refreshed] : [];
				},
			);
			const subscriptions = this.listSessionSubscriptions(sessionId, "active");
			for (const subscription of subscriptions) {
				const batch =
					this.getPendingReminderForSubscription(subscription.subscriptionId) ??
					this.buildReminderBatchForSubscription(subscription.subscriptionId, now);
				if (batch) batches.push(batch);
			}

			if (subscriptions.length === 0 && batches.length === 0) {
				const batch = this.buildReminderBatch(sessionId, now);
				if (batch) batches.push(batch);
			}
			if (batches.length === 0) return null;

			const reusableHandoffIds = new Set(
				batches.flatMap((batch) => {
					const record = this.getReminderBatchRecord(batch.batchId, sessionId);
					if (!record?.handoffId) return [];
					const settled = this.db.prepare(
						`SELECT 1 FROM reminder_handoff_settlements WHERE handoff_id = ?`,
					).get(record.handoffId);
					return settled ? [] : [record.handoffId];
				}),
			);
			const handoffId = reusableHandoffIds.size === 1
				? [...reusableHandoffIds][0]!
				: randomUUID();
			const handoffSize = batches.length;
			for (const batch of batches) {
				const record = this.getReminderBatchRecord(batch.batchId, sessionId);
				if (!record) throw new Error(`Missing reminder batch ${batch.batchId}`);
				if (
					record.state === "failed" &&
					!this.transitionReminderBatchState(
						batch.batchId,
						sessionId,
						"failed",
						"built",
						now,
					)
				)
					throw new Error(`Failed to retry reminder batch ${batch.batchId}`);

				const result = this.db
					.prepare(
						`UPDATE reminder_batches
						 SET state = 'handed_off', handoff_id = :handoffId,
						     handoff_size = :handoffSize, updated_at = :now
						 WHERE batch_id = :batchId AND session_id = :sessionId AND state = 'built'`,
					)
					.run({ handoffId, handoffSize, now, batchId: batch.batchId, sessionId });
				if (result.changes !== 1)
					throw new Error(`Failed to claim reminder batch ${batch.batchId}`);
			}
			const execution = this.claimHandoffExecution(handoffId, sessionId, owner, now);
			return {
				handoffId,
				executionGeneration: execution.executionGeneration,
				batches,
			};
		});
	}

	/** Resolves exactly one claimed reminder bundle atomically. */
	ackReminderBundle(payload: AckReminderBundlePayload, now = Date.now()): number {
		return this.transaction(() => {
			const records = this.listInFlightReminderBatchRecords(
				payload.sessionId,
				payload.handoffId,
			);
			if (records.length === 0) {
				const settlement = this.db.prepare(
					`SELECT settlement_state, acknowledged_count FROM reminder_handoff_settlements
					 WHERE handoff_id = ? AND session_id = ?`,
				).get(payload.handoffId, payload.sessionId) as
					| { settlement_state: "confirmed" | "failed"; acknowledged_count: number }
					| undefined;
				return settlement?.settlement_state === payload.state
					? settlement.acknowledged_count
					: 0;
			}
			const expectedSize = records[0].handoffSize;
			if (
				expectedSize !== records.length ||
				records.some(
					(record) =>
						record.handoffId !== payload.handoffId ||
						record.handoffSize !== expectedSize,
				)
			)
				throw new Error(`Incomplete reminder handoff ${payload.handoffId}`);

			for (const record of records) {
				const acknowledged = this.ackReminder(
					{
						batchId: record.batchId,
						sessionId: payload.sessionId,
						state: payload.state,
						...(payload.error ? { error: payload.error } : {}),
					},
					now,
				);
				if (!acknowledged)
					throw new Error(`Failed to acknowledge reminder batch ${record.batchId}`);
			}
			this.db.prepare(
				`INSERT INTO reminder_handoff_settlements
				 (handoff_id, session_id, settlement_state, acknowledged_count, settled_at)
				 VALUES (:handoffId, :sessionId, :state, :acknowledgedCount, :settledAt)
				 ON CONFLICT(handoff_id) DO NOTHING`,
			).run({
				handoffId: payload.handoffId,
				sessionId: payload.sessionId,
				state: payload.state,
				acknowledgedCount: records.length,
				settledAt: now,
			});
			this.db.prepare(
				`UPDATE reminder_handoff_execution_claims SET settled_at = :now
				 WHERE handoff_id = :handoffId AND session_id = :sessionId AND settled_at IS NULL`,
			).run({ handoffId: payload.handoffId, sessionId: payload.sessionId, now });
			if (payload.state === "failed") {
				this.db
					.prepare(
						`UPDATE reminder_batches SET handoff_id = NULL, handoff_size = NULL
						 WHERE session_id = :sessionId AND handoff_id = :handoffId`,
					)
					.run({ sessionId: payload.sessionId, handoffId: payload.handoffId });
				this.db
					.prepare(
						`DELETE FROM reminder_batches
						 WHERE session_id = :sessionId AND state = 'failed'
						   AND (
						     subscription_id IN (
						       SELECT subscription_id FROM session_subscriptions
						       WHERE session_id = :sessionId AND state != 'active'
						     )
						     OR canceled_at IS NOT NULL
						     OR (
						       subscription_id IS NULL
						       AND NOT EXISTS (
						         SELECT 1 FROM sessions
						         WHERE session_id = :sessionId AND pr_number IS NOT NULL
						       )
						     )
						   )`,
					)
					.run({ sessionId: payload.sessionId });
			}
			return records.length;
		});
	}

	/**
	 * Claims exactly one durable reminder for Claude in the same SQLite
	 * transaction that selects/builds it. This prevents a second Stop hook from
	 * observing a built batch between the read and handoff transition.
	 */
	claimClaudeReminder(
		sessionId: string,
		now = Date.now(),
	): ReminderBatch | null {
		return this.transaction(() => {
			this.expireStaleHandoffs(undefined, now);
			let record = this.getPendingReminderRecord(sessionId);
			if (!record) {
				const built = this.buildReminderBatch(sessionId, now);
				if (!built) return null;
				record = this.getReminderBatchRecord(built.batchId, sessionId);
				if (!record) return null;
			}
			if (record.state === "failed") {
				if (
					!this.transitionReminderBatchState(
						record.batchId,
						sessionId,
						"failed",
						"built",
						now,
					)
				)
					return null;
			}
			const batch = this.getPendingReminder(sessionId);
			if (!batch) return null;
			return this.transitionReminderBatchState(
				batch.batchId,
				sessionId,
				"built",
				"handed_off",
				now,
			)
				? batch
				: null;
		});
	}

	/** Confirms only the session's current Stop-boundary handoff. */
	confirmClaudeHandoff(sessionId: string, now = Date.now()): boolean {
		const row = this.db
			.prepare(
				`SELECT batch_id FROM reminder_batches
				 WHERE session_id = :sessionId AND state = 'handed_off'
				 ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
			)
			.get({ sessionId }) as { batch_id: string } | undefined;
		return row ? this.confirmReminderBatch(row.batch_id, sessionId, now) : false;
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
				   AND (reminder_batches.subscription_id IS NOT NULL
				        OR reminder_batches.canceled_at IS NULL)
				   AND (reminder_batches.subscription_id IS NULL OR session_subscriptions.state = 'active')
				 ORDER BY reminder_batches.created_at ASC LIMIT 1`,
			)
			.get({ sessionId }) as ReminderRow | undefined;
		return this.toReminderBatchRecord(row);
	}

	/**
	 * True when a batch is mid-handoff for this target. Such a row is invisible to
	 * `getPendingReminderRecord` (which only surfaces `built`/`failed`) yet still
	 * occupies the subscription's unique batch slot, so builders must treat it as
	 * "already pending" rather than inserting a second row.
	 */
	hasInFlightHandoff(sessionId: string, subscriptionId: string | null): boolean {
		const row = subscriptionId
			? (this.db
					.prepare(
						`SELECT 1 FROM reminder_batches
						 WHERE subscription_id = :subscriptionId AND state = 'handed_off' LIMIT 1`,
					)
					.get({ subscriptionId }) as { 1: number } | undefined)
			: (this.db
					.prepare(
						`SELECT 1 FROM reminder_batches
						 WHERE session_id = :sessionId AND subscription_id IS NULL
						   AND state = 'handed_off' LIMIT 1`,
					)
					.get({ sessionId }) as { 1: number } | undefined);
		return row !== undefined;
	}

	/**
	 * Returns abandoned handoffs to `failed` so the handoff registry can retry
	 * them. Without this, an adapter that dies between `handed_off` and
	 * `confirmed` strands its batch until the next daemon restart runs
	 * `recoverFromRestart`, and every queued event behind it goes undelivered.
	 */
	expireStaleHandoffs(
		thresholdMs = PREMIND_REMINDER_HANDOFF_STALE_MS,
		now = Date.now(),
	): number {
		const result = this.db
			.prepare(
				`UPDATE reminder_batches SET state = 'failed', updated_at = :now
				 WHERE state = 'handed_off' AND updated_at < :cutoff`,
			)
			.run({ now, cutoff: now - thresholdMs });
		this.db
			.prepare(
				`DELETE FROM reminder_batches
				 WHERE canceled_at IS NOT NULL AND state = 'failed'`,
			)
			.run();
		return result.changes as number;
	}

	getReminderBatchRecord(
		batchId: string,
		sessionId?: string,
	): ReminderBatchRecord | null {
		const row = (
			sessionId
				? this.db
						.prepare(
							`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
						        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq, reminder_batches.handoff_id, reminder_batches.handoff_size,
						        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
						 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
						 WHERE batch_id = :batchId AND reminder_batches.session_id = :sessionId`,
						)
						.get({ batchId, sessionId })
				: this.db
						.prepare(
							`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
						        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state, reminder_batches.max_event_seq, reminder_batches.handoff_id, reminder_batches.handoff_size,
						        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
						 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
						 WHERE batch_id = :batchId`,
						)
						.get({ batchId })
		) as ReminderRow | undefined;
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

	listInFlightReminderBatchRecords(
		sessionId: string,
		handoffId?: string,
	): ReminderBatchRecord[] {
		const rows = this.db
			.prepare(
				`SELECT reminder_batches.batch_id, reminder_batches.session_id, reminder_batches.subscription_id,
				        reminder_batches.reminder_text, reminder_batches.events_json, reminder_batches.state,
				        reminder_batches.max_event_seq, reminder_batches.handoff_id, reminder_batches.handoff_size,
				        session_subscriptions.repo, session_subscriptions.pr_number, session_subscriptions.source
				 FROM reminder_batches LEFT JOIN session_subscriptions USING (subscription_id)
				 WHERE reminder_batches.session_id = :sessionId
				   AND reminder_batches.state = 'handed_off'
				   AND (:handoffId IS NULL OR reminder_batches.handoff_id = :handoffId)
				 ORDER BY reminder_batches.created_at ASC`,
			)
			.all({ sessionId, handoffId: handoffId ?? null }) as ReminderRow[];
		return rows.flatMap((row) => {
			const record = this.toReminderBatchRecord(row);
			return record ? [record] : [];
		});
	}

	private listPendingLegacyReminderBatchRecords(
		sessionId: string,
	): ReminderBatchRecord[] {
		const rows = this.db
			.prepare(
				`SELECT reminder_batches.batch_id, reminder_batches.session_id,
				        reminder_batches.subscription_id, reminder_batches.reminder_text,
				        reminder_batches.events_json, reminder_batches.state,
				        reminder_batches.max_event_seq, reminder_batches.handoff_id,
				        reminder_batches.handoff_size, sessions.repo, sessions.pr_number,
				        NULL AS source
				 FROM reminder_batches
				 LEFT JOIN sessions ON sessions.session_id = reminder_batches.session_id
				 WHERE reminder_batches.session_id = :sessionId
				   AND reminder_batches.subscription_id IS NULL
				   AND reminder_batches.canceled_at IS NULL
				   AND reminder_batches.state IN ('built', 'failed')
				 ORDER BY reminder_batches.created_at ASC`,
			)
			.all({ sessionId }) as ReminderRow[];
		return rows.flatMap((row) => {
			const record = this.toReminderBatchRecord(row);
			return record ? [record] : [];
		});
	}

	private getPendingReminderForSubscription(
		subscriptionId: string,
	): ReminderBatch | null {
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
		return record ? this.refreshPendingReminder(record) : null;
	}

	private refreshPendingReminder(
		record: ReminderBatchRecord,
	): ReminderBatch | null {
		if (record.state !== "built" && record.state !== "failed") {
			return null;
		}

		const target = this.resolveReminderTarget(record);
		if (!target) {
			return this.toReminderBatch(record);
		}

		const sourceEvents = this.loadBatchSourceEvents(record, target);
		const currentSnapshot = this.loadReminderSnapshot(target);
		const rendered = renderReminder(sourceEvents, currentSnapshot, target);

		return this.persistRefreshedReminderBatch({
			...record,
			...target,
			...rendered,
		});
	}

	private resolveReminderTarget(
		record: ReminderBatchRecord,
	): ReminderTarget | null {
		const session = this.getSession(record.sessionId);
		const subscription = record.subscriptionId
			? this.getSubscriptionById(record.subscriptionId)
			: null;
		const repo = subscription?.repo ?? record.repo ?? session?.repo;
		if (!repo) {
			return null;
		}

		const prNumber =
			subscription?.prNumber ?? record.prNumber ?? session?.pr_number ?? undefined;
		const policy = subscription?.policy;
		const snapshot = prNumber ? this.getSnapshot(repo, prNumber) : null;
		const worktree = policy === "actionable"
			? this.getWorktreeBinding(record.sessionId)
			: null;
		const worktreeMatchesTarget = policy === "actionable"
			? worktree?.repo === repo &&
				worktree.branch === snapshot?.core.headRefName
			: undefined;

		return {
			repo,
			prNumber,
			source: subscription?.source ?? record.source,
			policy,
			worktreeMatchesTarget,
		};
	}

	private loadReminderSnapshot(
		target: ReminderTarget,
	): PullRequestSnapshot | null {
		if (!target.prNumber) {
			return null;
		}
		return this.getSnapshot(target.repo, target.prNumber);
	}

	private loadBatchSourceEvents(
		record: ReminderBatchRecord,
		target: ReminderTarget,
	): EventRow[] {
		const storedEvents = record.events as RenderedReminderEvent[];
		const window = this.getReminderEventWindow(record);
		let sourceEvents: EventRow[];

		if (this.needsLegacyEventRecovery(storedEvents)) {
			sourceEvents = this.recoverLegacyBatchEvents(record, target, window);
		} else {
			sourceEvents = this.loadEventsBySourceId(target, window);
		}

		return this.preserveMissingEventHistory(storedEvents, sourceEvents);
	}

	private getReminderEventWindow(
		record: ReminderBatchRecord,
	): ReminderEventWindow {
		const sourceEventIds = new Set<number>();
		for (const event of record.events as RenderedReminderEvent[]) {
			for (const id of event.sourceEventIds ?? [event.eventId]) {
				sourceEventIds.add(Number(id));
			}
		}

		let maximumEventSequence = record.maxEventSeq;
		if (maximumEventSequence === null) {
			const validSequences = [...sourceEventIds].filter(Number.isSafeInteger);
			maximumEventSequence = Math.max(0, ...validSequences);
		}

		return { sourceEventIds: [...sourceEventIds], maximumEventSequence };
	}

	private needsLegacyEventRecovery(events: RenderedReminderEvent[]): boolean {
		for (const event of events) {
			if (event.sourceEventIds?.length) {
				continue;
			}
			if ((event.count ?? 1) > 1 || event.kind === "check.superseded") {
				return true;
			}
		}
		return false;
	}

	private loadEventsBySourceId(
		target: ReminderTarget,
		window: ReminderEventWindow,
	): EventRow[] {
		if (!target.prNumber) {
			return [];
		}

		return this.db
			.prepare(
				`SELECT seq, kind, priority, summary, reference_link, payload_json
			 FROM pr_events
			 WHERE repo = :repo AND pr_number = :prNumber
			   AND seq <= :maximumSequence
			   AND seq IN (SELECT value FROM json_each(:sourceEventIds))
			 ORDER BY seq ASC`,
			)
			.all({
				repo: target.repo,
				prNumber: target.prNumber,
				maximumSequence: window.maximumEventSequence,
				sourceEventIds: JSON.stringify(window.sourceEventIds),
			}) as EventRow[];
	}

	private recoverLegacyBatchEvents(
		record: ReminderBatchRecord,
		target: ReminderTarget,
		window: ReminderEventWindow,
	): EventRow[] {
		if (!target.prNumber) {
			return [];
		}

		// Older groups saved only a representative ID. Recover their original
		// stream window, without including events that arrived after this batch.
		return this.db
			.prepare(
				`SELECT seq, kind, priority, summary, reference_link, payload_json
			 FROM pr_events
			 WHERE repo = :repo AND pr_number = :prNumber
			   AND seq <= :maximumSequence
			   AND (seq IN (SELECT value FROM json_each(:sourceEventIds))
			        OR seq > :lastDeliveredSequence)
			 ORDER BY seq ASC`,
			)
			.all({
				repo: target.repo,
				prNumber: target.prNumber,
				maximumSequence: window.maximumEventSequence,
				sourceEventIds: JSON.stringify(window.sourceEventIds),
				lastDeliveredSequence: this.getReminderDeliveryCursor(record),
			}) as EventRow[];
	}

	private getReminderDeliveryCursor(record: ReminderBatchRecord): number {
		if (record.subscriptionId) {
			const subscription = this.getSubscriptionById(record.subscriptionId);
			if (subscription) {
				return subscription.lastDeliveredEventSeq;
			}
		}
		return this.getSession(record.sessionId)?.last_delivered_event_seq ?? 0;
	}

	private preserveMissingEventHistory(
		storedEvents: RenderedReminderEvent[],
		sourceEvents: EventRow[],
	): EventRow[] {
		const recoveredIds = new Set(sourceEvents.map((row) => String(row.seq)));
		for (const event of storedEvents) {
			const sourceIds = event.sourceEventIds ?? [event.eventId];
			if (sourceIds.some((id) => recoveredIds.has(id))) {
				continue;
			}

			// Preserve missing/pruned history without inventing payload identity.
			// The renderer will request verification rather than assert a blocker.
			sourceEvents.push(this.toUnverifiedSourceEvent(event));
		}
		return sourceEvents;
	}

	private toUnverifiedSourceEvent(event: RenderedReminderEvent): EventRow {
		return {
			seq: Number(event.eventId),
			kind: event.kind,
			priority: event.priority,
			summary: event.summary,
			reference_link: event.referenceLink ?? null,
			payload_json: "{}",
		};
	}

	private persistRefreshedReminderBatch(
		record: ReminderBatchRecord,
	): ReminderBatch | null {
		const result = this.db
			.prepare(
				`UPDATE reminder_batches SET reminder_text = :text, events_json = :events
				 WHERE batch_id = :batchId AND session_id = :sessionId AND state IN ('built', 'failed')`,
			)
			.run({
				text: record.reminderText,
				events: JSON.stringify(record.events),
				batchId: record.batchId,
				sessionId: record.sessionId,
			});
		if (!result.changes) {
			return null;
		}
		return this.toReminderBatch(record);
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

	private toReminderBatchRecord(
		row: ReminderRow | undefined,
	): ReminderBatchRecord | null {
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
				handoffId: row.handoff_id ?? null,
				handoffSize: row.handoff_size ?? null,
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

	confirmReminderBatch(
		batchId: string,
		sessionId: string,
		now = Date.now(),
	): boolean {
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
						.run({
							seq: row.max_event_seq,
							now,
							subscriptionId: row.subscription_id,
						});
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
				.prepare(
					`DELETE FROM reminder_batches WHERE batch_id = :batchId AND state = 'confirmed'`,
				)
				.run({ batchId });
			return true;
		});
	}

	ackReminder(payload: AckReminderPayload, now = Date.now()) {
		const record = this.getReminderBatchRecord(
			payload.batchId,
			payload.sessionId,
		);
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
          WHERE repo = :repo AND branch = :branch
            AND status IN ('active', 'paused')
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
		if (!session || session.status !== "active") return null;

		const subscription = subscriptionId
			? this.getSubscriptionById(subscriptionId)
			: this.listSessionSubscriptions(sessionId, "active").find(
					(candidate) =>
						this.listUndeliveredEventsForSubscription(candidate.subscriptionId)
							.length > 0,
				);
		if (
			subscription &&
			(subscription.sessionId !== sessionId || subscription.state !== "active")
		)
			return null;

		const targetRepo = subscription?.repo ?? session.repo;
		const targetPrNumber = subscription?.prNumber ?? session.pr_number;

		const existing = subscription
			? this.getPendingReminderForSubscription(subscription.subscriptionId)
			: this.getPendingReminder(sessionId);
		if (existing) return existing;

		// A batch already handed to an adapter still owns its events: the delivery
		// cursor only advances on `confirmed`, so those events are still undelivered
		// here. Building a replacement would violate the one-batch-per-subscription
		// invariant (`reminder_batches.subscription_id` is UNIQUE) and, because
		// callers such as `PullRequestWatcher.tick` swallow per-target errors, the
		// throw would silently wedge every future poll for this PR. Wait for the
		// handoff to resolve, or for `expireStaleHandoffs` to return it to `failed`.
		if (this.hasInFlightHandoff(sessionId, subscription?.subscriptionId ?? null))
			return null;

		const events = subscription
			? this.listUndeliveredEventsForSubscription(subscription.subscriptionId)
			: this.listUndeliveredEvents(sessionId);
		if (events.length === 0) return null;
		const maxEventSeq = events.at(-1)!.seq;
		const targetSnapshot = targetPrNumber
			? this.getSnapshot(targetRepo, targetPrNumber) : null;
		const worktree = subscription?.policy === "actionable"
			? this.getWorktreeBinding(sessionId) : null;
		const worktreeMatchesTarget = subscription?.policy === "actionable"
			? worktree?.repo === targetRepo &&
				worktree.branch === targetSnapshot?.core.headRefName : undefined;
		const { reminderText, events: condensed } = renderReminder(
			events,
			targetSnapshot,
			{
				repo: targetRepo,
				prNumber: targetPrNumber ?? undefined,
				source: subscription?.source,
				policy: subscription?.policy,
				worktreeMatchesTarget,
			},
		);
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
			...(subscription
				? {
						subscriptionId: subscription.subscriptionId,
						source: subscription.source,
					}
				: {}),
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
            WHERE sessions.status IN ('active', 'paused')
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
              AND sessions.status IN ('active', 'paused')
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
                    AND sessions.status IN ('active', 'paused')
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

      CREATE TABLE IF NOT EXISTS session_daemon_leases (
        session_id TEXT PRIMARY KEY,
        owner_instance_id TEXT,
        generation INTEGER NOT NULL,
        client_incarnation_nonce TEXT,
        lease_token_hash TEXT,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS storage_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        storage_epoch INTEGER NOT NULL,
        daemon_generation INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO storage_metadata (singleton, storage_epoch, daemon_generation)
      VALUES (1, 1, 0)
      ON CONFLICT(singleton) DO NOTHING;

      CREATE TABLE IF NOT EXISTS daemon_instance_leases (
        instance_id TEXT PRIMARY KEY,
        incarnation_nonce TEXT NOT NULL,
        storage_epoch INTEGER NOT NULL,
        generation INTEGER NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coordinator_leases (
        resource_key TEXT PRIMARY KEY,
        owner_instance_id TEXT,
        owner_generation INTEGER,
        storage_epoch INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        lease_expires_at INTEGER
      );

      INSERT INTO coordinator_leases
        (resource_key, owner_instance_id, owner_generation, storage_epoch, generation, lease_expires_at)
      VALUES ('background-coordinator', NULL, NULL, 1, 0, NULL)
      ON CONFLICT(resource_key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        host TEXT NOT NULL DEFAULT 'opencode' CHECK(host IN ('opencode', 'pi', 'claude')),
        host_session_id TEXT NOT NULL,
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
        updated_at INTEGER NOT NULL,
        UNIQUE(host, host_session_id)
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
        ownership TEXT NOT NULL DEFAULT 'unknown' CHECK(ownership IN ('self', 'foreign', 'unknown')),
        policy TEXT NOT NULL DEFAULT 'observe-only' CHECK(policy IN ('actionable', 'observe-only')),
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
        handoff_id TEXT,
        handoff_size INTEGER,
        canceled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY(subscription_id) REFERENCES session_subscriptions(subscription_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reminder_handoff_settlements (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        settlement_state TEXT NOT NULL CHECK(settlement_state IN ('confirmed', 'failed')),
        acknowledged_count INTEGER NOT NULL,
        settled_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminder_handoff_execution_claims (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        execution_generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        settled_at INTEGER
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
			!sessionColumns.some((column) => column.name === "last_delivered_event_seq")
		) {
			this.db.exec(
				`ALTER TABLE sessions ADD COLUMN last_delivered_event_seq INTEGER NOT NULL DEFAULT 0`,
			);
		}
		if (!sessionColumns.some((column) => column.name === "host")) {
			this.db.exec(
				`ALTER TABLE sessions ADD COLUMN host TEXT NOT NULL DEFAULT 'opencode'`,
			);
		}
		if (!sessionColumns.some((column) => column.name === "host_session_id")) {
			this.db.exec(`ALTER TABLE sessions ADD COLUMN host_session_id TEXT`);
		}
		// Existing rows predate host tracking. Claude's stable synthetic client ID
		// makes that origin unambiguous; remaining legacy rows retain OpenCode's
		// historic default. host_session_id mirrors the pre-host session key.
		this.db.exec(`
			UPDATE sessions
			SET host = CASE WHEN client_id LIKE 'claude:%' THEN 'claude' ELSE host END,
				host_session_id = COALESCE(NULLIF(host_session_id, ''), session_id);
			CREATE UNIQUE INDEX IF NOT EXISTS sessions_host_session_id_unique
			ON sessions(host, host_session_id);
		`);

		const subscriptionColumns = this.db
			.prepare(`PRAGMA table_info(session_subscriptions)`)
			.all() as Array<{ name: string }>;
		if (!subscriptionColumns.some((column) => column.name === "ownership")) {
			this.db.exec(
				"ALTER TABLE session_subscriptions ADD COLUMN ownership TEXT NOT NULL DEFAULT 'unknown'",
			);
		}
		if (!subscriptionColumns.some((column) => column.name === "policy")) {
			this.db.exec(
				"ALTER TABLE session_subscriptions ADD COLUMN policy TEXT NOT NULL DEFAULT 'observe-only'",
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
		// SQLite cannot bind identifiers or type definitions in DDL, so each of these
		// is a fully static statement rather than an interpolated one. Verbose, but it
		// removes any possibility of a dynamically constructed ALTER.
		const hasPrWatcherColumn = (name: string) =>
			prWatcherColumns.some((column) => column.name === name);
		if (!hasPrWatcherColumn("state")) {
			this.db.exec(
				"ALTER TABLE pr_watchers ADD COLUMN state TEXT NOT NULL DEFAULT 'stopped'",
			);
		}
		if (!hasPrWatcherColumn("idle_deadline_at")) {
			this.db.exec("ALTER TABLE pr_watchers ADD COLUMN idle_deadline_at INTEGER");
		}
		if (!hasPrWatcherColumn("terminal_at")) {
			this.db.exec("ALTER TABLE pr_watchers ADD COLUMN terminal_at INTEGER");
		}
		if (!hasPrWatcherColumn("next_eligible_poll_at")) {
			this.db.exec(
				"ALTER TABLE pr_watchers ADD COLUMN next_eligible_poll_at INTEGER",
			);
		}
		if (!hasPrWatcherColumn("consecutive_failures")) {
			this.db.exec(
				"ALTER TABLE pr_watchers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
			);
		}
		if (!hasPrWatcherColumn("last_failure_at")) {
			this.db.exec("ALTER TABLE pr_watchers ADD COLUMN last_failure_at INTEGER");
		}
		if (!hasPrWatcherColumn("last_failure_message")) {
			this.db.exec("ALTER TABLE pr_watchers ADD COLUMN last_failure_message TEXT");
		}
		if (!hasPrWatcherColumn("rate_limit_reset_at")) {
			this.db.exec(
				"ALTER TABLE pr_watchers ADD COLUMN rate_limit_reset_at INTEGER",
			);
		}
		this.db.exec(
			`UPDATE pr_watchers
			 SET state = 'warming_up'
			 WHERE active_session_count > 0 AND state = 'stopped'`,
		);

		const reminderColumns = this.db
			.prepare(`PRAGMA table_info(reminder_batches)`)
			.all() as Array<{ name: string }>;
		if (!reminderColumns.some((column) => column.name === "max_event_seq")) {
			this.db.exec(
				`ALTER TABLE reminder_batches ADD COLUMN max_event_seq INTEGER`,
			);
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
					handoff_id TEXT,
					handoff_size INTEGER,
					canceled_at INTEGER,
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
		const currentReminderColumns = this.db
			.prepare(`PRAGMA table_info(reminder_batches)`)
			.all() as Array<{ name: string }>;
		if (!currentReminderColumns.some((column) => column.name === "handoff_id")) {
			this.db.exec(`ALTER TABLE reminder_batches ADD COLUMN handoff_id TEXT`);
		}
		if (!currentReminderColumns.some((column) => column.name === "handoff_size")) {
			this.db.exec(`ALTER TABLE reminder_batches ADD COLUMN handoff_size INTEGER`);
		}
		if (!currentReminderColumns.some((column) => column.name === "canceled_at")) {
			this.db.exec(`ALTER TABLE reminder_batches ADD COLUMN canceled_at INTEGER`);
		}
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS reminder_batches_handoff
			ON reminder_batches(session_id, handoff_id, state);
		`);

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
			return (
				columns.map((column) => column.name).join(",") ===
				"repo,pr_number,dedupe_key"
			);
		});
		if (!hasScopedEventUniqueness) {
			const previousSequence = (
				this.db
					.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'pr_events'`)
					.get() as { seq: number } | undefined
			)?.seq;
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
					this.db
						.prepare(`DELETE FROM sqlite_sequence WHERE name = 'pr_events'`)
						.run();
					this.db
						.prepare(
							`INSERT INTO sqlite_sequence (name, seq) VALUES ('pr_events', ?)`,
						)
						.run(previousSequence);
				}
			});
		}
	}
}

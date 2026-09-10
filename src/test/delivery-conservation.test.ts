/**
 * Conservation under lifecycle churn.
 *
 * The scenario tests in `delivery-reliability.test.ts` each pin one *known*
 * failure mechanism. They were written after the fact, so they prove a fix
 * holds — they cannot discover the next bug of the same family, because you
 * have to already know which disruption to write.
 *
 * Both defects found while working issue #23 had the same shape:
 *
 *   an event was persisted -> a lifecycle disruption happened -> the event was
 *   never delivered, and nothing reported it
 *
 * So this file asserts invariants over a *space* of disruptions instead of one
 * hand-picked story:
 *
 *   P1 delivery conservation - every event persisted while a subscription is
 *      active is eventually covered by exactly one confirmed batch.
 *   P2 watch liveness - once things settle, an active subscription on a live
 *      session is pollable. No state that claims to be watched but is not.
 *
 * Only *transparent* disruptions belong here: ones that must never lose an
 * event. Intentional history-skipping is deliberately excluded, because
 * folding it in would make the suite fail constantly until someone loosened it
 * into uselessness:
 *
 *   - a first automatic attach baselines at high water (don't dump stale history)
 *   - a repo/branch context change resets the cursor and clears batches
 *   - a brand-new session id is a new consumer, not a restart, and must not
 *     inherit another session's cursor (several sessions routinely share one
 *     branch, e.g. many sessions on `main` in one checkout)
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../daemon/persistence/store.ts"
import { ReminderHandoffRegistry } from "../daemon/reminders/reminder-handoff-registry.ts"
import { PrWatcherRegistry } from "../daemon/watchers/pr-watcher-registry.ts"
import { PullRequestWatcher } from "../daemon/watchers/pr-watcher.ts"
import type {
	GitHubClientLike,
	PullRequestSnapshotResult,
} from "../daemon/github/client.ts"
import type { PullRequestSnapshot } from "../daemon/github/types.ts"

const REPO = "acme/repo"
const PR = 42
const BRANCH = "feature/test"
const SESSION = "conservation-session"
const CLIENT = "conservation-client"

/** Comfortably past the reminder-handoff staleness window. */
const STEP_MS = 10 * 60_000

const tempDirs: string[] = []

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()
		if (dir) fs.rmSync(dir, { recursive: true, force: true })
	}
})

const snapshotWithComments = (count: number): PullRequestSnapshot => ({
	core: {
		number: PR,
		title: "Test PR",
		url: `https://github.com/${REPO}/pull/${PR}`,
		state: "OPEN",
		isDraft: false,
		headRefName: BRANCH,
		baseRefName: "main",
		headRefOid: "sha-1",
		mergeStateStatus: "CLEAN",
		reviewDecision: null,
		reviewRequests: [],
		updatedAt: "2026-04-08T00:00:00Z",
	},
	reviews: [],
	issueComments: Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		body: `comment ${index + 1}`,
		user: { login: "reviewer" },
	})),
	reviewComments: [],
	checks: [],
	fetchedAt: 1_000,
})

/** Serves whatever snapshot the world most recently staged. */
class StagedGitHub implements GitHubClientLike {
	current: PullRequestSnapshot = snapshotWithComments(0)
	private etag = 0

	async getViewerLogin() {
		return "octocat"
	}
	async findOpenPullRequestForBranch() {
		return { kind: "ok" as const, pr: null, etag: null }
	}
	async fetchPullRequestSnapshot(): Promise<PullRequestSnapshotResult> {
		this.etag++
		return { kind: "ok", snapshot: this.current, etag: `etag-${this.etag}` }
	}
}

type Coverage = { from: number; to: number }

/**
 * One self-contained premind world: a store, a watcher, an automatic
 * subscription, and a ledger of which event sequences were actually delivered.
 */
class World {
	readonly dir: string
	readonly dbPath: string
	store: StateStore
	github = new StagedGitHub()
	watcher: PullRequestWatcher
	handoffs: ReminderHandoffRegistry
	watchers: PrWatcherRegistry
	now = 5_000_000_000_000

	/** Ranges (exclusive, inclusive] covered by confirmed batches. */
	readonly covered: Coverage[] = []
	/** Highest event seq ingested so far. */
	ingestedThrough = 0
	/** Cursor at the moment the subscription was established. */
	baseline = 0
	private comments = 0
	readonly log: string[] = []

	constructor() {
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-conservation-"))
		tempDirs.push(this.dir)
		this.dbPath = path.join(this.dir, "premind.db")
		this.store = new StateStore(this.dbPath)
		this.watcher = new PullRequestWatcher(this.store, this.github)
		this.handoffs = new ReminderHandoffRegistry(this.store)
		this.watchers = new PrWatcherRegistry(this.store, { now: this.now })

		this.store.registerClient(CLIENT, { pid: 1, projectRoot: "/tmp" }, this.now)
		this.store.registerSession(
			{
				clientId: CLIENT,
				sessionId: SESSION,
				repo: REPO,
				branch: BRANCH,
				isPrimary: true,
				status: "active",
				busyState: "idle",
			},
			this.now,
		)
		this.store.upsertWorktreeBinding(
			{
				sessionId: SESSION,
				root: "/tmp/worktree",
				gitDir: "/tmp/.git/worktrees/test",
				repo: REPO,
				branch: BRANCH,
				headSha: "sha-1",
				state: "following_automatic_pr",
			},
			this.now,
		)
		this.store.recordBranchAssociation(REPO, BRANCH, PR, this.now)
		this.store.baselineAutomaticSubscription(
			{ sessionId: SESSION, repo: REPO, prNumber: PR },
			this.now,
		)
	}

	get subscriptionId() {
		const subscription = this.store.getSubscription(SESSION, REPO, PR)
		assert.ok(subscription, "the world lost its subscription entirely")
		return subscription.subscriptionId
	}

	get cursor() {
		return this.store.getSubscriptionById(this.subscriptionId)?.lastDeliveredEventSeq ?? 0
	}

	advance(ms = STEP_MS) {
		this.now += ms
	}

	/** Establish the starting cursor, then treat everything after as owed. */
	async start() {
		this.github.current = snapshotWithComments(0)
		await this.watcher.tick(this.now)
		await this.drain()
		this.baseline = this.cursor
		this.ingestedThrough = this.baseline
		this.log.push(`baseline=${this.baseline}`)
	}

	/** A new comment lands on the PR and is polled into the database. */
	async ingest() {
		this.comments++
		this.github.current = snapshotWithComments(this.comments)
		this.advance()
		await this.watcher.tick(this.now)
		const maxSeq = this.store.getSnapshot(REPO, PR) ? this.maxEventSeq() : 0
		this.ingestedThrough = Math.max(this.ingestedThrough, maxSeq)
		this.log.push(`ingest -> through=${this.ingestedThrough}`)
	}

	/** Stage a new comment without polling it, for disruptions that tick themselves. */
	async stageAnotherComment() {
		this.comments++
		this.github.current = snapshotWithComments(this.comments)
	}

	/** Whatever the watcher last recorded as a poll failure, if anything. */
	lastPollFailure() {
		return this.store.getPrWatcherRecord(REPO, PR)?.lastFailureMessage ?? null
	}

	/** Re-read the max ingested seq; disruptions that tick must keep the ledger honest. */
	syncIngestedThrough() {
		this.ingestedThrough = Math.max(this.ingestedThrough, this.maxEventSeq())
	}

	private maxEventSeq() {
		const row = (this.store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }).db
			.prepare(`SELECT MAX(seq) AS maxSeq FROM pr_events WHERE repo = ? AND pr_number = ?`)
			.get(REPO, PR) as { maxSeq: number | null }
		return row?.maxSeq ?? 0
	}

	/** Deliver everything currently on offer, recording what each batch covered. */
	async drain(limit = 10) {
		for (let round = 0; round < limit; round++) {
			const batch = this.handoffs.getPendingReminder(SESSION, this.now)
			if (!batch) return
			const before = this.cursor
			const record = this.store.getReminderBatchRecord(batch.batchId, SESSION)
			const to = record?.maxEventSeq ?? before
			this.store.ackReminder(
				{ batchId: batch.batchId, sessionId: SESSION, state: "handed_off" },
				this.now,
			)
			this.store.ackReminder(
				{ batchId: batch.batchId, sessionId: SESSION, state: "confirmed" },
				this.now,
			)
			if (this.cursor !== before) {
				this.covered.push({ from: before, to })
				this.log.push(`deliver (${before}, ${to}]`)
			}
		}
	}

	close() {
		this.handoffs.close()
		this.watchers.close()
		this.store.close()
	}

	describe() {
		return {
			log: this.log,
			baseline: this.baseline,
			ingestedThrough: this.ingestedThrough,
			cursor: this.cursor,
			covered: this.covered,
			subscriptionState: this.store.getSubscription(SESSION, REPO, PR)?.state,
			sessionStatus: this.store.getSession(SESSION)?.status,
			pollTargets: this.store.listPrWatchTargets(this.now).map((t) => `${t.repo}#${t.pr_number}`),
		}
	}
}

/**
 * Disruptions that must be transparent: whatever they do to sessions,
 * watchers, or batches, no persisted event may be lost.
 */
const DISRUPTIONS: Record<string, (world: World) => Promise<void> | void> = {
	/** The adapter took the batch and died before confirming. */
	adapterCrashMidHandoff: (world) => {
		const batch = world.handoffs.getPendingReminder(SESSION, world.now)
		if (!batch) return
		world.store.ackReminder(
			{ batchId: batch.batchId, sessionId: SESSION, state: "handed_off" },
			world.now,
		)
	},

	/**
	 * The adapter died mid-handoff and the watcher polls again *before* the
	 * staleness window elapses. This is the common case in production — polls
	 * run every 20s-5m, well inside the 5 minute reclamation window — and it is
	 * the path where a rebuild attempt collides with the surviving handed_off
	 * row. Reclamation cannot paper over it because it has not fired yet.
	 */
	adapterCrashThenQuickPoll: async (world) => {
		const batch = world.handoffs.getPendingReminder(SESSION, world.now)
		if (batch) {
			world.store.ackReminder(
				{ batchId: batch.batchId, sessionId: SESSION, state: "handed_off" },
				world.now,
			)
		}
		world.advance(30_000) // still inside the handoff staleness window
		await world.stageAnotherComment()
		await world.watcher.tick(world.now)
	},

	/** Every session start does this, and it deactivates automatic subscriptions. */
	reactivateWorktree: (world) => {
		world.store.activateWorktree(
			{
				sessionId: SESSION,
				root: "/tmp/worktree",
				gitDir: "/tmp/.git/worktrees/test",
				repo: REPO,
				branch: BRANCH,
				headSha: "sha-1",
				state: "waiting_for_pr",
			},
			world.now,
		)
		// Branch discovery re-attaches shortly afterwards.
		world.store.baselineAutomaticSubscription(
			{ sessionId: SESSION, repo: REPO, prNumber: PR },
			world.now,
		)
	},

	/** Adapter reattaches to the same repo/branch. */
	reattachSessionControl: (world) => {
		world.store.ensureSessionControl(
			{
				clientId: CLIENT,
				sessionId: SESSION,
				repo: REPO,
				branch: BRANCH,
				isPrimary: true,
				busyState: "idle",
				paused: false,
			},
			world.now,
		)
	},

	/** The daemon process restarts on the same database file. */
	daemonRestart: (world) => {
		world.handoffs.close()
		world.watchers.close()
		world.store.close()
		world.store = new StateStore(world.dbPath)
		world.store.recoverFromRestart(world.now)
		world.watcher = new PullRequestWatcher(world.store, world.github)
		world.handoffs = new ReminderHandoffRegistry(world.store)
		world.watchers = new PrWatcherRegistry(world.store, { now: world.now })
	},

	/** The session went quiet, was reaped, then the user came back. */
	reapThenRevive: (world) => {
		world.store.reapStaleSessions(0, world.now)
		world.store.updateSessionState({ sessionId: SESSION, busyState: "idle" }, world.now)
	},

	/** A poll failed; the watcher backs off and must come back. */
	watcherBackoff: (world) => {
		world.watchers.reconcile(world.now)
		if (world.watchers.has(REPO, PR)) {
			world.watchers.recordPollFailure(REPO, PR, new Error("transient"), world.now)
		}
	},

	/** Ordinary busy/idle churn around a turn. */
	busyIdleChurn: (world) => {
		world.store.updateSessionState({ sessionId: SESSION, busyState: "busy" }, world.now)
		world.store.updateSessionState({ sessionId: SESSION, busyState: "idle" }, world.now)
	},
}

const DISRUPTION_KEYS = Object.keys(DISRUPTIONS)

/** P2: once things settle, a live session's active subscription is pollable. */
const assertWatchLiveness = (world: World, label: string) => {
	const subscription = world.store.getSubscription(SESSION, REPO, PR)
	const session = world.store.getSession(SESSION)
	if (!subscription || subscription.state !== "active") return
	if (!session || session.status === "closed") return

	const targets = world.store.listPrWatchTargets(world.now)
	assert.ok(
		targets.some((target) => target.repo === REPO && target.pr_number === PR),
		`${label}: an active subscription on a live session is not in the poll set — ` +
			`this is a silent unwatch\n${JSON.stringify(world.describe(), null, 2)}`,
	)

	world.watchers.reconcile(world.now)
	const state = world.watchers.getSnapshot(REPO, PR)?.value
	assert.notEqual(
		state,
		"stopped",
		`${label}: watcher is stopped while a live session still wants this PR`,
	)
}


/**
 * P3: no swallowed internal failure.
 *
 * `PullRequestWatcher.tick` catches per-target errors and logs a warning, so a
 * bug inside the tick (a constraint violation, say) is invisible except as a
 * recorded poll failure. Both #23 defects were silent precisely because
 * something failed where nobody was looking. The only failure this suite ever
 * expects is the one `watcherBackoff` injects on purpose.
 */
const EXPECTED_FAILURE = "transient"

const assertNoSwallowedFailure = (world: World, label: string) => {
	const failure = world.lastPollFailure()
	if (failure === null || failure === EXPECTED_FAILURE) return
	assert.fail(
		`${label}: the watcher swallowed an internal failure — ${failure}\n` +
			`${JSON.stringify(world.describe(), null, 2)}`,
	)
}
/** P1: the confirmed batches must tile every owed sequence exactly once. */
const assertConservation = (world: World, label: string) => {
	const owed: number[] = []
	for (let seq = world.baseline + 1; seq <= world.ingestedThrough; seq++) owed.push(seq)

	const deliveryCount = new Map<number, number>()
	for (const range of world.covered) {
		for (let seq = range.from + 1; seq <= range.to; seq++) {
			deliveryCount.set(seq, (deliveryCount.get(seq) ?? 0) + 1)
		}
	}

	const lost = owed.filter((seq) => !deliveryCount.has(seq))
	const duplicated = owed.filter((seq) => (deliveryCount.get(seq) ?? 0) > 1)
	const detail = JSON.stringify(world.describe(), null, 2)

	assert.deepEqual(lost, [], `${label}: events persisted but never delivered\n${detail}`)
	assert.deepEqual(duplicated, [], `${label}: events delivered more than once\n${detail}`)
}

/** Every single disruption, every ordered pair, plus adversarial longer runs. */
const buildSequences = (): string[][] => {
	const sequences: string[][] = DISRUPTION_KEYS.map((key) => [key])
	for (const first of DISRUPTION_KEYS) {
		for (const second of DISRUPTION_KEYS) sequences.push([first, second])
	}
	sequences.push(
		["adapterCrashMidHandoff", "daemonRestart", "reactivateWorktree"],
		["adapterCrashMidHandoff", "reactivateWorktree", "reapThenRevive"],
		["reactivateWorktree", "reactivateWorktree", "reactivateWorktree"],
		["reapThenRevive", "daemonRestart", "adapterCrashMidHandoff", "reactivateWorktree"],
		["watcherBackoff", "adapterCrashMidHandoff", "daemonRestart"],
	)
	return sequences
}

describe("delivery conservation under lifecycle churn", () => {
	const sequences = buildSequences()

	test(`no event is lost across ${sequences.length} disruption sequences`, async () => {
		for (const sequence of sequences) {
			const label = sequence.join(" -> ")
			const world = new World()
			try {
				await world.start()

				for (const key of sequence) {
					// A comment lands, then something disrupts the pipeline.
					await world.ingest()
					world.log.push(`disrupt ${key}`)
					await DISRUPTIONS[key](world)
					// Some disruptions poll on their own, so re-read what is now owed.
					world.syncIngestedThrough()
					world.advance()
					await world.drain()
					assertWatchLiveness(world, label)
					assertNoSwallowedFailure(world, label)
				}

				// Settle: polling resumes and anything still owed is delivered.
				world.advance()
				await world.watcher.tick(world.now)
				await world.drain()

				assert.ok(
					world.ingestedThrough > world.baseline,
					`${label}: the scenario never ingested anything, so it proves nothing`,
				)
				assertConservation(world, label)
			} finally {
				world.close()
			}
		}
	})

	test("the transparent disruption set is explicit", () => {
		// Intentional history-skipping is excluded on purpose; see the file header.
		assert.deepEqual(
			DISRUPTION_KEYS.sort(),
			[
				"adapterCrashMidHandoff",
				"adapterCrashThenQuickPoll",
				"busyIdleChurn",
				"daemonRestart",
				"reactivateWorktree",
				"reapThenRevive",
				"reattachSessionControl",
				"watcherBackoff",
			],
			"add new event-preserving lifecycle operations here so they are covered",
		)
	})
})

/**
 * One GitHub update, ingested once, fanned out to every supported adapter.
 *
 * The database is the real fan-out point, so replaying the whole GitHub path
 * per adapter would be duplicated work that proves nothing extra. This runner
 * ingests a single update through the production watcher, asserts the
 * persistence boundary, then closes and reopens SQLite so adapters can only
 * observe durable state.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StateStore } from "../../daemon/persistence/store.ts"
import { PullRequestWatcher } from "../../daemon/watchers/pr-watcher.ts"
import type {
	GitHubClientLike,
	PullRequestSnapshotResult,
} from "../../daemon/github/client.ts"
import type { PullRequestSnapshot } from "../../daemon/github/types.ts"

export const SCENARIO_REPO = "acme/repo"
export const SCENARIO_PR = 42

/** Queue-backed GitHub client; the final snapshot repeats once the queue drains. */
export class ScriptedGitHub implements GitHubClientLike {
	private index = 0
	readonly requestedEtags: Array<string | null> = []

	constructor(private readonly snapshots: PullRequestSnapshot[]) {}

	async getViewerLogin() {
		return "octocat"
	}

	async findOpenPullRequestForBranch() {
		return { kind: "ok" as const, pr: null, etag: null }
	}

	async fetchPullRequestSnapshot(
		_repo: string,
		_prNumber: number,
		context: { etag?: string | null } = {},
	): Promise<PullRequestSnapshotResult> {
		this.requestedEtags.push(context.etag ?? null)
		const next = this.snapshots[Math.min(this.index, this.snapshots.length - 1)]
		this.index++
		return { kind: "ok", snapshot: next, etag: `etag-${this.index}` }
	}
}

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
	core: {
		number: SCENARIO_PR,
		title: "Test PR",
		url: `https://github.com/${SCENARIO_REPO}/pull/${SCENARIO_PR}`,
		state: "OPEN",
		isDraft: false,
		headRefName: "feature/test",
		baseRefName: "main",
		headRefOid: "sha-1",
		mergeStateStatus: "CLEAN",
		reviewDecision: null,
		reviewRequests: [],
		updatedAt: "2026-04-08T00:00:00Z",
		...(overrides.core ?? {}),
	},
	reviews: overrides.reviews ?? [],
	issueComments: overrides.issueComments ?? [],
	reviewComments: overrides.reviewComments ?? [],
	checks: overrides.checks ?? [],
	fetchedAt: overrides.fetchedAt ?? 1_000,
})

/** Baseline, then one update carrying several distinct kinds of change. */
export const BASELINE_SNAPSHOT = snapshot()
export const UPDATED_SNAPSHOT = snapshot({
	core: { ...snapshot().core, headRefOid: "sha-2", reviewDecision: "APPROVED" },
	reviews: [{ id: 900, state: "APPROVED", body: "LGTM", user: { login: "lead" } }],
	issueComments: [{ id: 100, body: "please take a look", user: { login: "reviewer" } }],
	checks: [{ name: "build", state: "fail", link: "https://ci.example/build" }],
})

export type AdapterSession = {
	/** Adapter key, e.g. "opencode". */
	adapter: string
	sessionId: string
	branch: string
	subscriptionId: string
}

export type Scenario = {
	store: StateStore
	dbPath: string
	sessions: AdapterSession[]
	github: ScriptedGitHub
	/** Structured state for failure diagnostics. */
	describe: () => Record<string, unknown>
	cleanup: () => void
}

const T0 = 4_000_000_000_000

/**
 * Ingests baseline + one update, drains the baseline batch so every cursor
 * starts level, asserts persistence, then reopens the database.
 */
export const runPrUpdateScenario = async (
	adapters: Array<{ key: string; sessionId: string; branch: string }>,
): Promise<Scenario> => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-fanout-"))
	const dbPath = path.join(dir, "premind.db")
	let store = new StateStore(dbPath)

	const github = new ScriptedGitHub([BASELINE_SNAPSHOT, UPDATED_SNAPSHOT])
	const watcher = new PullRequestWatcher(store, github)

	const sessions: AdapterSession[] = []
	for (const adapter of adapters) {
		store.registerClient(`client-${adapter.key}`, { pid: 1, projectRoot: "/tmp" }, T0)
		store.registerSession(
			{
				clientId: `client-${adapter.key}`,
				sessionId: adapter.sessionId,
				repo: SCENARIO_REPO,
				// Distinct branches keep these sessions independent consumers of one
				// PR, which is what two adapters watching the same PR looks like.
				branch: adapter.branch,
				isPrimary: true,
				status: "active",
				busyState: "idle",
			},
			T0,
		)
		const subscription = store.upsertSubscription(
			{ sessionId: adapter.sessionId, repo: SCENARIO_REPO, prNumber: SCENARIO_PR, source: "manual" },
			T0,
		)
		sessions.push({
			adapter: adapter.key,
			sessionId: adapter.sessionId,
			branch: adapter.branch,
			subscriptionId: subscription.subscriptionId,
		})
	}

	// Baseline poll, then confirm the initialization batch so every subscription
	// starts from the same known cursor.
	await watcher.tick(T0)
	for (const session of sessions) {
		const baseline = store.buildReminderBatchForSubscription(session.subscriptionId, T0)
		if (!baseline) continue
		store.ackReminder({ batchId: baseline.batchId, sessionId: session.sessionId, state: "handed_off" }, T0)
		store.ackReminder({ batchId: baseline.batchId, sessionId: session.sessionId, state: "confirmed" }, T0)
	}

	// The update under test.
	await watcher.tick(T0 + 60_000)

	// --- persistence boundary, asserted before any adapter runs ---
	const stored = store.getSnapshot(SCENARIO_REPO, SCENARIO_PR)
	assert.equal(stored?.core.headRefOid, "sha-2", "the update is persisted")

	const perSubscription = sessions.map((session) => ({
		session,
		events: store.listUndeliveredEventsForSubscription(session.subscriptionId),
	}))
	for (const { session, events } of perSubscription) {
		assert.ok(events.length > 0, `${session.adapter} should have queued events`)
	}
	assert.deepEqual(
		[...new Set(perSubscription.map(({ events }) => events.map((e) => e.kind).join("|")))],
		[perSubscription[0].events.map((e) => e.kind).join("|")],
		"every subscription is owed the same source events",
	)

	// Replaying the same snapshot must not create new work. Depth on dedupe
	// lives in diff.test.ts; this only guards the fan-out path.
	const before = store.listUndeliveredEventsForSubscription(sessions[0].subscriptionId).length
	await watcher.tick(T0 + 120_000)
	assert.equal(
		store.listUndeliveredEventsForSubscription(sessions[0].subscriptionId).length,
		before,
		"replaying an unchanged snapshot adds no events",
	)

	// Adapters must only be able to see durable state.
	store.close()
	store = new StateStore(dbPath)

	const describe = () => ({
		dbPath,
		githubEtags: github.requestedEtags,
		snapshot: {
			headRefOid: store.getSnapshot(SCENARIO_REPO, SCENARIO_PR)?.core.headRefOid,
		},
		sessions: sessions.map((session) => ({
			adapter: session.adapter,
			sessionId: session.sessionId,
			cursor: store.getSubscriptionById(session.subscriptionId)?.lastDeliveredEventSeq,
			undelivered: store
				.listUndeliveredEventsForSubscription(session.subscriptionId)
				.map((event) => event.kind),
			pendingBatch: store.getPendingReminder(session.sessionId)?.batchId ?? null,
		})),
	})

	return {
		get store() {
			return store
		},
		dbPath,
		sessions,
		github,
		describe,
		cleanup: () => {
			try {
				store.close()
			} catch {
				// Already closed by the test.
			}
			if (process.env.PREMIND_KEEP_FAILED_HARNESS === "1") {
				console.error(`[harness] preserved database at ${dbPath}`)
				return
			}
			fs.rmSync(dir, { recursive: true, force: true })
		},
	}
}

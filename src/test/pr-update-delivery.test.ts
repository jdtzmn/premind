/**
 * Phase 2 of the issue #23 plan: cross-adapter fan-out.
 *
 * Adapter suites elsewhere prove each host injects a reminder it was handed.
 * They cannot prove the reminder came from the database, because they hand the
 * adapter a fabricated batch. This test ingests one GitHub update through the
 * production watcher, reopens SQLite, and then drives each supported adapter's
 * real lifecycle events against a router-backed daemon client.
 *
 * One ingestion, N adapters — the database is the fan-out point, so replaying
 * the GitHub path per adapter would prove nothing extra.
 */

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ADAPTER_DRIVERS } from "./harness/adapters/index.ts"
import { createRouterDaemonClient } from "./harness/router-daemon-client.ts"
import { runPrUpdateScenario, SCENARIO_PR, SCENARIO_REPO } from "./harness/pr-update-scenario.ts"
import type { Scenario } from "./harness/pr-update-scenario.ts"
import type { DeliveryCapture } from "./harness/adapters/index.ts"

/** Host-specific delivery contracts, asserted on top of the shared invariants. */
const HOST_CONTRACT: Record<string, (capture: DeliveryCapture) => void> = {
	opencode: () => {
		// promptAsync carries no envelope beyond the prompt text itself.
	},
	pi: (capture) => {
		assert.equal(capture.meta?.customType, "premind-reminder", "pi tags its reminder messages")
		assert.deepEqual(
			capture.meta?.options,
			{ deliverAs: "followUp", triggerTurn: true },
			"pi delivers as a follow-up that starts a turn",
		)
	},
}

describe("PR update fan-out", () => {
	test("one persisted update reaches every supported adapter", async () => {
		const scenario = await runPrUpdateScenario(
			ADAPTER_DRIVERS.map((driver) => ({
				key: driver.key,
				sessionId: driver.sessionId,
				branch: driver.branch,
			})),
		)

		try {
			assert.ok(ADAPTER_DRIVERS.length >= 2, "fan-out needs at least two adapters to be meaningful")

			for (const [index, driver] of ADAPTER_DRIVERS.entries()) {
				const session = scenario.sessions.find((candidate) => candidate.adapter === driver.key)
				assert.ok(session, `scenario is missing a session for ${driver.key}`)

				// What the daemon is holding for this session, before the adapter runs.
				const owed = scenario.store.getPendingReminder(session.sessionId)
				assert.ok(owed, `${driver.key} should have a batch waiting in the database`)
				const owedSeq = scenario.store.getReminderBatchRecord(owed.batchId)?.maxEventSeq
				assert.ok(owedSeq && owedSeq > 0, `${driver.key} batch should cover real events`)

				const daemonClient = createRouterDaemonClient(scenario.store, {
					clientId: `client-${driver.key}`,
					worktree: {
						root: "/tmp/project",
						gitDir: "/tmp/project/.git",
						repo: SCENARIO_REPO,
						branch: session.branch,
						headSha: "sha-2",
					},
				})

				const result = await driver.deliver({
					daemonClient,
					sessionId: session.sessionId,
					branch: session.branch,
				})

				// --- the adapter received exactly the persisted reminder ---
				assert.equal(result.captured.length, 1, `${driver.key} should deliver exactly one reminder`)
				const [capture] = result.captured
				assert.equal(capture.sessionId, session.sessionId, `${driver.key} targeted the wrong session`)
				assert.equal(
					capture.text,
					owed.reminderText,
					`${driver.key} delivered text that differs from the batch the daemon handed it`,
				)
				assert.ok(
					capture.text.includes("premind") || capture.text.length > 0,
					`${driver.key} delivered an empty reminder`,
				)
				HOST_CONTRACT[driver.key]?.(capture)

				// --- the handoff completed against real rows ---
				assert.equal(
					scenario.store.getReminderBatchRecord(owed.batchId),
					null,
					`${driver.key} should have confirmed its batch, which deletes the row`,
				)
				assert.equal(
					scenario.store.getSubscriptionById(session.subscriptionId)?.lastDeliveredEventSeq,
					owedSeq,
					`${driver.key} confirmation should advance its cursor to the batch high-water mark`,
				)
				assert.equal(
					scenario.store.listUndeliveredEventsForSubscription(session.subscriptionId).length,
					0,
					`${driver.key} should have nothing left owed`,
				)

				// --- delivering to one adapter must not consume another's update ---
				for (const later of ADAPTER_DRIVERS.slice(index + 1)) {
					const laterSession = scenario.sessions.find((candidate) => candidate.adapter === later.key)
					assert.ok(laterSession)
					assert.ok(
						scenario.store.listUndeliveredEventsForSubscription(laterSession.subscriptionId).length > 0,
						`${driver.key} delivery consumed ${later.key}'s pending update`,
					)
				}

				// --- a second idle boundary must not re-deliver ---
				await result.idleAgain()
				assert.equal(
					result.captured.length,
					1,
					`${driver.key} re-delivered a batch it had already confirmed`,
				)
			}

			// Every adapter ended up level on the same source events.
			const cursors = scenario.sessions.map(
				(session) => scenario.store.getSubscriptionById(session.subscriptionId)?.lastDeliveredEventSeq,
			)
			assert.equal(
				new Set(cursors).size,
				1,
				`adapters finished at different cursors: ${JSON.stringify(cursors)}`,
			)
			assert.equal(
				scenario.store.getSnapshot(SCENARIO_REPO, SCENARIO_PR)?.core.headRefOid,
				"sha-2",
				"the persisted snapshot is still the updated one after delivery",
			)
		} catch (error) {
			console.error(
				"[fan-out harness] scenario state at failure:\n",
				JSON.stringify(scenario.describe(), null, 2),
			)
			throw error
		} finally {
			scenario.cleanup()
		}
	})

	test("the adapter registry covers every implemented harness", () => {
		// Guards against a new production adapter shipping without fan-out proof.
		assert.deepEqual(
			ADAPTER_DRIVERS.map((driver) => driver.key).sort(),
			["opencode", "pi"],
			"update the driver registry when an adapter is added or removed",
		)
	})
})

export type { Scenario }

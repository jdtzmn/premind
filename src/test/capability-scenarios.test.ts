/**
 * Shared capability scenarios, run through every harness's real model tools.
 *
 * Each scenario is written once and executed against every adapter driver that
 * exposes a tool for its capability. A harness without that tool is excused
 * only by the typed exception declared in `command-capabilities.ts`, which
 * `command-capabilities.test.ts` already requires. The coverage test below
 * fails when a capability gains a model tool without a scenario.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { StateStore } from "../daemon/persistence/store.ts"
import {
	type CommandCapability,
	type CommandCapabilityId,
	commandCapabilities,
	harnessSurface,
	type PremindHarness,
	premindHarnesses,
} from "../shared/command-capabilities.ts"
import { ADAPTER_DRIVERS } from "./harness/adapters/index.ts"
import type { AdapterDriver, HarnessControls } from "./harness/adapters/types.ts"
import { createRouterDaemonClient, type RouterDaemonClient } from "./harness/router-daemon-client.ts"

const REPO = "acme/repo"

type ScenarioContext = {
	driver: AdapterDriver
	controls: HarnessControls
	store: StateStore
	daemonClient: RouterDaemonClient
	sessionId: string
}

type CapabilityScenario = {
	name: string
	/** Capabilities whose model tools this scenario exercises. */
	capabilities: readonly CommandCapabilityId[]
	run: (context: ScenarioContext) => Promise<void>
}

const assertSucceeded = (
	result: { text: string; isError: boolean },
	label: string,
) => {
	assert.equal(result.isError, false, `${label} failed: ${result.text}`)
	assert.ok(result.text.trim(), `${label} returned no text`)
}

const SCENARIOS: CapabilityScenario[] = [
	{
		name: "status reads daemon state",
		capabilities: ["status"],
		async run({ driver, controls, daemonClient }) {
			const before = daemonClient.operations.filter((op) => op === "debugStatus").length
			assertSucceeded(await controls.invoke("status"), `${driver.key} status`)
			assert.ok(
				daemonClient.operations.filter((op) => op === "debugStatus").length > before,
				`${driver.key} status did not read daemon state`,
			)
		},
	},
	{
		name: "doctor returns a diagnostic",
		capabilities: ["doctor"],
		async run({ driver, controls }) {
			assertSucceeded(await controls.invoke("doctor"), `${driver.key} doctor`)
		},
	},
	{
		name: "set active checkout binds the session's worktree",
		capabilities: ["set-active-checkout"],
		async run({ driver, controls, store, sessionId }) {
			assertSucceeded(
				await controls.invoke("set-active-checkout", { path: "/tmp/project" }),
				`${driver.key} set-active-checkout`,
			)
			const binding = store.getWorktreeBinding(sessionId)
			assert.equal(binding?.repo, REPO, `${driver.key} did not bind the active checkout`)
			assert.equal(binding?.root, "/tmp/project")
		},
	},
	{
		name: "subscribe and unsubscribe change only the session's subscriptions",
		capabilities: ["subscribe", "unsubscribe"],
		async run({ driver, controls, store, sessionId }) {
			assertSucceeded(
				await controls.invoke("subscribe", { prNumber: 99, repo: "acme/other" }),
				`${driver.key} subscribe`,
			)
			assert.equal(
				store.getSubscription(sessionId, "acme/other", 99)?.state,
				"active",
				`${driver.key} subscribe did not create an active subscription`,
			)
			assertSucceeded(
				await controls.invoke("unsubscribe", { prNumber: 99, repo: "acme/other" }),
				`${driver.key} unsubscribe`,
			)
			assert.notEqual(
				store.getSubscription(sessionId, "acme/other", 99)?.state,
				"active",
				`${driver.key} unsubscribe left the subscription active`,
			)
		},
	},
	{
		name: "deliver hands pending reminders to the session",
		capabilities: ["deliver"],
		async run({ driver, controls, store, sessionId }) {
			const subscription = store.upsertSubscription({
				sessionId,
				repo: REPO,
				prNumber: 7,
				source: "manual",
			})
			const batchId = store.createOrReplaceReminder(
				sessionId,
				subscription.subscriptionId,
				`Scenario reminder for ${driver.key}`,
				[],
				0,
			)
			assertSucceeded(await controls.invoke("deliver"), `${driver.key} deliver`)
			assert.notEqual(
				store.getReminderBatchRecord(batchId)?.state,
				"built",
				`${driver.key} deliver left the pending reminder unclaimed`,
			)
			assert.ok(
				controls.captured.some((capture) => capture.text.includes(`${REPO}#7`)),
				`${driver.key} deliver did not inject the reminder into the session`,
			)
		},
	},
	{
		name: "global disable and enable toggle the daemon-wide switch when confirmed",
		capabilities: ["disable", "enable"],
		async run({ driver, controls, store }) {
			assertSucceeded(
				await controls.invoke("disable", { confirmGlobal: true }),
				`${driver.key} disable`,
			)
			assert.equal(store.isGloballyDisabled(), true, `${driver.key} disable did not take effect`)
			assertSucceeded(
				await controls.invoke("enable", { confirmGlobal: true }),
				`${driver.key} enable`,
			)
			assert.equal(store.isGloballyDisabled(), false, `${driver.key} enable did not take effect`)
		},
	},
	{
		name: "unconfirmed global disable and enable are refused before reaching the daemon",
		capabilities: ["disable", "enable"],
		async run({ driver, controls, daemonClient }) {
			const globalWrites = () =>
				daemonClient.operations.filter((operation) => operation === "setGlobalDisabled").length
			for (const action of ["disable", "enable"] as const) {
				for (const params of [{}, { confirmGlobal: false }]) {
					const result = await controls.invoke(action, params)
					assert.equal(result.isError, true, `${driver.key} ${action} accepted ${JSON.stringify(params)}`)
					assert.match(result.text, /confirmGlobal: true/, `${driver.key} ${action} refusal`)
				}
			}
			assert.equal(globalWrites(), 0, `${driver.key} reached the daemon without confirmation`)
		},
	},
	{
		name: "pause withholds reminders without changing subscriptions, and resume releases them",
		capabilities: ["pause", "resume"],
		async run({ driver, controls, store, sessionId }) {
			const subscription = store.upsertSubscription({
				sessionId,
				repo: REPO,
				prNumber: 8,
				source: "manual",
			})
			const subscriptions = () =>
				store
					.listSessionSubscriptions(sessionId)
					.map(({ subscriptionId, state }) => ({ subscriptionId, state }))
			const before = subscriptions()

			assertSucceeded(await controls.invoke("pause"), `${driver.key} pause`)
			assert.equal(store.isSessionPaused(sessionId), true, `${driver.key} pause did not take effect`)
			const batchId = store.createOrReplaceReminder(
				sessionId,
				subscription.subscriptionId,
				`Paused reminder for ${driver.key}`,
				[],
				0,
			)
			await controls.crossDeliveryBoundary()
			assert.ok(
				!controls.captured.some((capture) => capture.text.includes(`${REPO}#8`)),
				`${driver.key} delivered a reminder while paused`,
			)
			assert.equal(store.getReminderBatchRecord(batchId)?.state, "built")
			assert.deepEqual(subscriptions(), before, `${driver.key} pause changed subscriptions`)

			assertSucceeded(await controls.invoke("resume"), `${driver.key} resume`)
			assert.equal(store.isSessionPaused(sessionId), false, `${driver.key} resume did not take effect`)
			assert.deepEqual(subscriptions(), before, `${driver.key} resume changed subscriptions`)
			await controls.crossDeliveryBoundary()
			assert.ok(
				controls.captured.some((capture) => capture.text.includes(`${REPO}#8`)),
				`${driver.key} did not deliver the queued reminder after resume`,
			)
		},
	},
	{
		name: "a host restart keeps manual subscriptions and the updates still owed on them",
		capabilities: ["subscribe"],
		async run({ driver, controls, store, sessionId }) {
			assertSucceeded(
				await controls.invoke("subscribe", { prNumber: 99, repo: "acme/other" }),
				`${driver.key} subscribe`,
			)
			const before = store.getSubscription(sessionId, "acme/other", 99)
			assert.equal(before?.state, "active")
			store.insertEvents("acme/other", 99, [
				{
					dedupeKey: `restart:${driver.key}`,
					kind: "issue_comment.created",
					priority: "high",
					summary: "A comment that has not been delivered yet",
					payload: {},
				},
			])

			const restarted = await controls.restart()
			const after = store.getSubscription(sessionId, "acme/other", 99)
			assert.equal(after?.state, "active", `${driver.key} restart dropped the manual subscription`)
			assert.equal(
				after?.subscriptionId,
				before?.subscriptionId,
				`${driver.key} restart replaced the subscription instead of keeping it`,
			)
			assert.equal(
				store.listUndeliveredEventsForSubscription(after.subscriptionId).length,
				1,
				`${driver.key} restart lost an update that was still owed`,
			)
			await restarted.shutdown()
		},
	},
	{
		name: "a pause survives a host restart and stale-session reaping",
		capabilities: ["pause", "resume"],
		async run({ driver, controls, store, sessionId }) {
			assertSucceeded(await controls.invoke("pause"), `${driver.key} pause`)
			let current = await controls.restart()
			assert.equal(store.isSessionPaused(sessionId), true, `${driver.key} restart lifted the pause`)

			// The daemon closes sessions that stay quiet; the host revives them later.
			store.reapStaleSessions(0, Date.now() + 1)
			current = await current.restart()
			assert.equal(store.isSessionPaused(sessionId), true, `${driver.key} reaping lifted the pause`)

			const subscription = store.upsertSubscription({
				sessionId,
				repo: REPO,
				prNumber: 9,
				source: "manual",
			})
			store.createOrReplaceReminder(sessionId, subscription.subscriptionId, "Restarted", [], 0)
			await current.crossDeliveryBoundary()
			assert.ok(
				!current.captured.some((capture) => capture.text.includes(`${REPO}#9`)),
				`${driver.key} delivered a reminder after restarting while paused`,
			)

			assertSucceeded(await current.invoke("resume"), `${driver.key} resume`)
			await current.crossDeliveryBoundary()
			assert.ok(
				current.captured.some((capture) => capture.text.includes(`${REPO}#9`)),
				`${driver.key} did not deliver after resuming a restarted session`,
			)
			await current.shutdown()
		},
	},
]

const hasTool = (capabilityId: CommandCapabilityId, harness: PremindHarness) =>
	harnessSurface(commandCapabilities[capabilityId] as CommandCapability, harness).tools.length > 0

describe("shared capability scenarios", () => {
	test("every capability with a model tool has a shared scenario", () => {
		const covered = new Set(SCENARIOS.flatMap((scenario) => scenario.capabilities))
		for (const capabilityId of Object.keys(commandCapabilities) as CommandCapabilityId[]) {
			const toolHarnesses = premindHarnesses.filter((harness) => hasTool(capabilityId, harness))
			if (toolHarnesses.length === 0) continue
			assert.ok(
				covered.has(capabilityId),
				`${capabilityId} has model tools (${toolHarnesses.join(", ")}) but no shared scenario`,
			)
		}
	})

	for (const scenario of SCENARIOS) {
		for (const driver of ADAPTER_DRIVERS) {
			const harness = driver.key as PremindHarness
			const missing = scenario.capabilities.filter((capabilityId) => !hasTool(capabilityId, harness))
			test(`${driver.key}: ${scenario.name}`, { skip: missing.length > 0 && `excused by declared ${missing.join(", ")} exception` }, async () => {
				const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-scenario-"))
				const store = new StateStore(path.join(directory, "premind.db"))
				const daemonClient = createRouterDaemonClient(store, {
					clientId: `scenario-${driver.key}`,
					worktree: {
						root: "/tmp/project",
						gitDir: "/tmp/project/.git",
						repo: REPO,
						branch: driver.branch,
						headSha: "scenario-sha",
					},
				})
				let controls: HarnessControls | undefined
				try {
					controls = await driver.createControls({
						daemonClient,
						sessionId: driver.sessionId,
						branch: driver.branch,
					})
					await scenario.run({
						driver,
						controls,
						store,
						daemonClient,
						sessionId: driver.sessionId,
					})
				} catch (error) {
					console.error(
						`[capability scenario:${driver.key}] daemon traffic:`,
						daemonClient.operations.join(" -> "),
					)
					throw error
				} finally {
					await controls?.shutdown().catch(() => undefined)
					store.close()
					fs.rmSync(directory, { recursive: true, force: true })
				}
			})
		}
	}
})

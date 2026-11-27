import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"
import { BRANCH, REPO, startE2EEnvironment, type E2EEnvironment } from "./environment.ts"
import { textOf } from "./fake-model.ts"
import { locateHost, type HostDriver, type HostInstance, type HostSession } from "./host.ts"
import { packedPremind } from "./package.ts"

/** Hosts poll the daemon for idle delivery; Pi's default interval is 15s. */
const DELIVERY_TIMEOUT_MS = 60_000

/**
 * The shared baseline every host must pass: packed Premind attaches a real
 * session, a pull request update reaches the model as one reminder, the daemon
 * records the host's confirmation, and a host restart repeats nothing.
 */
export function pullRequestDeliveryScenario(driver: HostDriver) {
	const located = locateHost(driver)
	const skip = "missing" in located ? located.missing : false

	describe(`${driver.harness}: pull request delivery`, { skip, timeout: 300_000 }, () => {
		let e2e: E2EEnvironment
		let host: HostInstance | undefined
		let session: HostSession
		let sessionId: string
		let comment: string

		const daemonSession = () => e2e.daemon.session(sessionId)
		/** User messages containing `text` in the latest model request that has any. */
		const occurrencesInLatestRequest = (text: string) => {
			const requests = e2e.model.requests.filter((request) =>
				request.messages.some((message) => message.role === "user" && textOf(message.content).includes(text)),
			)
			const latest = requests.at(-1)
			return latest?.messages.filter((message) => message.role === "user" && textOf(message.content).includes(text)).length ?? 0
		}
		const expectDelivered = async (text: string) => {
			const confirmed = e2e.daemon.confirmedHandoffs(sessionId).length
			await e2e.waitFor(`"${text}" in the model input`, () => e2e.model.userMessages().some((message) => message.includes(text)), DELIVERY_TIMEOUT_MS)
			await e2e.waitFor("the daemon to record the host's confirmation", () => e2e.daemon.confirmedHandoffs(sessionId).length > confirmed)
			await e2e.waitFor("the session to settle", () => daemonSession()?.busy_state === "idle")
			assert.equal(occurrencesInLatestRequest(text), 1, "the update reaches the model in one reminder")
		}

		before(async () => {
			if ("missing" in located) return
			e2e = await startE2EEnvironment({ model: driver.model, diagnostics: () => host?.output() ?? "" })
			e2e.github.addPullRequest({ repo: REPO, number: 42, headRefName: BRANCH, title: "Add widgets" })
			host = await driver.start(e2e, { binary: located.binary, packageRoot: packedPremind() })
		})

		after(async () => {
			try {
				await host?.stop()
			} finally {
				await e2e?.close()
			}
		})

		test("attaches a new session and delivers its open pull request", async () => {
			session = await host!.openSession()
			await session.prompt("hello")
			const attached = await e2e.waitFor("the session to attach to Premind", () =>
				e2e.daemon.primarySessions().find((row) => row.host === driver.harness && row.status === "active"),
			)
			sessionId = attached.session_id
			await expectDelivered(`Discovered open PR ${REPO}#42`)
		})

		test("wakes the idle session for a review comment and confirms it", async () => {
			comment = `Reviewer note ${randomUUID()}`
			e2e.github.addComment(REPO, 42, { author: "reviewer", body: comment })
			await expectDelivered(comment)
		})

		test("resumes the session after a host restart without repeating reminders", async () => {
			const confirmed = e2e.daemon.confirmedHandoffs(sessionId)
			const before = e2e.model.requests.length
			await host!.restart()
			session = await host!.resumeSession(session)
			await session.prompt("after restart")
			await e2e.waitFor(() => `the resumed session to be active and idle (sessions: ${JSON.stringify(e2e.daemon.primarySessions())}, expected ${sessionId})`, () =>
				daemonSession()?.status === "active" && daemonSession()?.busy_state === "idle",
			)
			assert.ok(e2e.model.requests.length > before, "the resumed session ran a turn")
			assert.equal(occurrencesInLatestRequest(comment), 1, "history holds the reminder once")
			assert.deepEqual(e2e.daemon.confirmedHandoffs(sessionId), confirmed, "no reminder was delivered again")
		})
	})
}

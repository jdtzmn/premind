import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { test } from "node:test"
import { BRANCH, REPO, startE2EEnvironment } from "./environment.ts"

test("e2e environment provides an isolated checkout wired to the fakes", async () => {
	const e2e = await startE2EEnvironment({ parent: { PATH: process.env.PATH, GITHUB_TOKEN: "must-not-leak" } })
	try {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: e2e.sandbox.workspace, env: e2e.env, encoding: "utf8" }).trim()
		assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), BRANCH)
		assert.equal(git("remote", "get-url", "origin"), `https://github.com/${REPO}.git`)
		assert.equal(e2e.env.GITHUB_TOKEN, undefined)
		assert.equal(e2e.env.PREMIND_GITHUB_API_URL, e2e.github.url)
		assert.equal(e2e.env.PREMIND_STATE_DIR, e2e.sandbox.state)
		assert.deepEqual(e2e.daemon.primarySessions(), [], "no daemon has started")
		await assert.rejects(
			e2e.waitFor("something that never happens", () => false, 200),
			/Timed out waiting for something that never happens/,
		)
	} finally {
		await e2e.close()
	}
	assert.equal(existsSync(e2e.sandbox.root), false)
})

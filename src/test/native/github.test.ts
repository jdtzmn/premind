import assert from "node:assert/strict"
import { test } from "node:test"
import { startScriptedGitHub } from "./github.ts"
import { startNativeProcess } from "./process.ts"
import { createNativeSandbox } from "./sandbox.ts"

const headers = { Authorization: "Bearer native-fixture-no-auth" }

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const sandbox = createNativeSandbox()
	const children: Array<ReturnType<typeof startNativeProcess>> = []
	let github: Awaited<ReturnType<typeof startScriptedGitHub>> | undefined
	t.after(async () => {
		try { await Promise.all(children.map((child) => child.stop())) }
		finally { try { if (github) await github.stop() } finally { sandbox.dispose() } }
	})
	github = await startScriptedGitHub(sandbox)
	return { sandbox, github, children }
}

test("GitHub external fixture separates baseline and fresh comments", async (t) => {
	const { github } = await fixture(t)
	const snapshot = async () => {
		const response = await fetch(`${github.baseUrl}/graphql`, { method: "POST", headers, body: JSON.stringify({
			query: "query PullRequestSnapshot", variables: { owner: "native", repo: "fixture", number: 17 },
		}) })
		assert.equal(response.status, 200)
		return response.json()
	}
	const observed = github.waitForSnapshot(1, 1000)
	assert.deepEqual((await snapshot()).data.repository.pullRequest.comments.nodes, [])
	await observed
	github.publishComment("fresh-external-marker")
	assert.equal((await snapshot()).data.repository.pullRequest.comments.nodes[0].body, "fresh-external-marker")
	assert.equal(github.snapshots, 2)
	assert.equal((await fetch(`${github.baseUrl}/unexpected`, { headers })).status, 404)
	assert.equal((await fetch(`${github.baseUrl}/user`)).status, 401)
	assert.throws(() => github.waitForSnapshot(0), /Invalid snapshot wait/)
	await assert.rejects(github.waitForSnapshot(3, 10), /expected snapshot 3/)
})

test("child-only GitHub preload redirects the real fetch transport and blocks other origins", async (t) => {
	const { sandbox, github, children } = await fixture(t)
	const child = startNativeProcess({
		label: "GitHub transport control", command: process.execPath, env: github.env, cwd: sandbox.workspace,
		args: ["--import", github.preload, "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			const response = await fetch(new Request("https://api.github.com/user", { headers: ${JSON.stringify(headers)} }));
			assert.equal((await response.json()).login, "native-author");
			await assert.rejects(async () => fetch("https://example.invalid/"), /Unexpected GitHub fixture fetch origin/);
			console.log("routed-and-blocked");
		`],
	})
	children.push(child)
	await child.waitForOutput("routed-and-blocked", 2000)
	assert.equal((await child.exited).code, 0)
})

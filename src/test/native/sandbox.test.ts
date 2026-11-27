import assert from "node:assert/strict"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { premindHarnesses } from "../../shared/command-capabilities.ts"
import { createNativeSandbox } from "./sandbox.ts"

for (const harness of premindHarnesses) {
	test(`${harness}: native sandbox isolates personal state and secrets`, (t) => {
		const sandbox = createNativeSandbox({
			PATH: "/fixture/bin", HOME: "/personal/home",
			OPENAI_API_KEY: "must-not-leak", GITHUB_TOKEN: "must-not-leak",
			NODE_OPTIONS: "--import=/personal/hook.mjs",
			PI_CODING_AGENT_DIR: "/personal/pi", CODEX_HOME: "/personal/codex",
			CLAUDE_CONFIG_DIR: "/personal/claude", XDG_CONFIG_HOME: "/personal/config",
			PREMIND_STATE_DIR: "/personal/premind", PREMIND_SOCKET_PATH: "/personal/socket",
			HTTPS_PROXY: "must-not-leak",
		})
		t.after(() => sandbox.dispose())
		assert.equal(sandbox.env.PATH, "/fixture/bin")
		for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "HTTPS_PROXY"]) {
			assert.equal(sandbox.env[name], undefined, name)
		}
		for (const [name, value] of Object.entries(sandbox.env)) {
			if (name === "PATH" || name === "LANG" || name === "NO_COLOR") continue
			assert.ok(value?.startsWith(`${sandbox.root}${path.sep}`), name)
		}
		assert.ok(Buffer.byteLength(sandbox.socket) < 100, "portable Unix socket length")
		assert.equal(statSync(sandbox.root).mode & 0o777, 0o700)
		assert.ok(existsSync(sandbox.workspace))
	})
}

test("parallel native sandboxes have distinct state and idempotent disposal", () => {
	const first = createNativeSandbox()
	const second = createNativeSandbox()
	try {
		assert.notEqual(first.root, second.root)
		assert.notEqual(first.socket, second.socket)
		assert.notEqual(first.env.PREMIND_STATE_DIR, second.env.PREMIND_STATE_DIR)
		first.dispose()
		first.dispose()
		assert.equal(existsSync(first.root), false)
		assert.equal(existsSync(second.root), true)
	} finally {
		first.dispose()
		second.dispose()
	}
})

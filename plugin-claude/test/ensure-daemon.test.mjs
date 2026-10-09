import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const legacyEntry = path.join(root, "src/test/fixtures/legacy-daemon/premind-daemon.mjs")
const ensureDaemonUrl = new URL("../bin/ensure-daemon.mjs", import.meta.url).href

const readLockPid = (stateDir) => {
	try {
		return Number(fs.readFileSync(path.join(stateDir, "daemon.lock"), "utf8").split(":")[0])
	} catch {
		return undefined
	}
}
const isAlive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

test("Claude's launcher replaces a pre-handover daemon with its bundled daemon", async () => {
	const dir = fs.mkdtempSync(path.join("/tmp", "premind-claude-launch-"))
	const stateDir = path.join(dir, "state")
	fs.mkdirSync(stateDir)
	const socketPath = path.join(dir, "premind.sock")
	const legacy = spawn(process.execPath, [legacyEntry, socketPath, path.join(stateDir, "daemon.lock")], {
		stdio: ["ignore", "pipe", "ignore"],
	})
	await new Promise((resolve) => legacy.stdout.once("data", resolve))
	const legacyExited = new Promise((resolve) => legacy.once("exit", resolve))
	let daemonPid
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const { ensureDaemonRunning } = await import(${JSON.stringify(ensureDaemonUrl)}); process.stdout.write(String(await ensureDaemonRunning()))`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PREMIND_STATE_DIR: stateDir, PREMIND_SOCKET_PATH: socketPath },
				timeout: 20_000,
			},
		)
		assert.equal(result.stdout, "true", result.stderr)
		await legacyExited
		daemonPid = readLockPid(stateDir)
		assert.ok(daemonPid, "the bundled daemon holds the daemon lock")
		assert.notEqual(daemonPid, legacy.pid)
		assert.equal(isAlive(daemonPid), true)
	} finally {
		if (legacy.exitCode === null) legacy.kill("SIGKILL")
		if (daemonPid) {
			try {
				process.kill(daemonPid, "SIGTERM")
			} catch {
				// Already gone.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

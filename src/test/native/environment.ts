import { execFileSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { readDaemonLockOwner } from "../../shared/daemon-startup.ts"
import { startFakeGitHub, type FakeGitHub } from "../harness/fake-github.ts"
import { daemonState, type DaemonState } from "./daemon-state.ts"
import { startFakeModel, type FakeModel, type FakeModelOptions } from "./fake-model.ts"
import { createNativeSandbox, type NativeSandbox } from "./sandbox.ts"

export const REPO = "acme/widgets"
export const BRANCH = "feature/widgets"

/**
 * Everything a host needs except the host itself:
 *
 *   fake GitHub ─▶ real Premind daemon ─▶ (host under test) ─▶ fake model
 *
 * The workspace is a Git checkout of `REPO` on `BRANCH`. `env` is the sandbox
 * allowlist plus the fake GitHub settings; hosts start Premind's daemon
 * themselves, as they do for users, and the daemon inherits `env`.
 */
export type E2EEnvironment = {
	sandbox: NativeSandbox
	github: FakeGitHub
	model: FakeModel
	daemon: DaemonState
	env: NodeJS.ProcessEnv
	/** Poll `condition` until it is truthy; fail with `diagnostics()` on timeout. */
	waitFor<T>(description: string, condition: () => T | Promise<T>, timeoutMs?: number): Promise<NonNullable<T>>
	/** Stop the daemon and fakes and remove the sandbox. Stop the host first. */
	close(): Promise<void>
}

export async function startE2EEnvironment(options: {
	model?: FakeModelOptions
	/** Host output to append when a wait times out. */
	diagnostics?: () => string
	parent?: NodeJS.ProcessEnv
} = {}): Promise<E2EEnvironment> {
	const sandbox = createNativeSandbox(options.parent)
	const closers: Array<() => Promise<void> | void> = [() => sandbox.dispose()]
	try {
		const github = await startFakeGitHub()
		closers.unshift(() => github.close())
		const model = await startFakeModel(options.model)
		closers.unshift(() => model.close())
		const env: NodeJS.ProcessEnv = { ...sandbox.env, ...github.env() }
		createCheckout(sandbox.workspace, env)
		const daemon = daemonState(sandbox.state, sandbox.socket)
		closers.unshift(() => stopDaemon(sandbox.state))

		const waitFor: E2EEnvironment["waitFor"] = async (description, condition, timeoutMs = 20_000) => {
			const deadline = Date.now() + timeoutMs
			for (;;) {
				const value = await condition()
				if (value) return value as NonNullable<typeof value>
				if (Date.now() > deadline) {
					throw new Error(`Timed out waiting for ${description}\n${options.diagnostics?.().slice(-6000) ?? ""}`)
				}
				await delay(100)
			}
		}

		return {
			sandbox,
			github,
			model,
			daemon,
			env,
			waitFor,
			close: async () => {
				for (const close of closers.splice(0)) await close()
			},
		}
	} catch (error) {
		for (const close of closers) await close()
		throw error
	}
}

function createCheckout(directory: string, env: NodeJS.ProcessEnv) {
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=Premind E2E", "-c", "user.email=e2e@premind.invalid", "-c", "commit.gpgsign=false", ...args], {
			cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
		})
	git("init", "-q", "-b", BRANCH)
	git("remote", "add", "origin", `https://github.com/${REPO}.git`)
	git("commit", "-q", "--allow-empty", "-m", "Initial commit")
}

/** The host starts the daemon detached, so stopping the host leaves it running. */
async function stopDaemon(stateDir: string) {
	const pid = readDaemonLockOwner(stateDir)?.pid
	if (!pid) return
	try {
		process.kill(pid, "SIGTERM")
	} catch {
		return
	}
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			process.kill(pid, 0)
		} catch {
			return
		}
		await delay(100)
	}
	try {
		process.kill(pid, "SIGKILL")
	} catch {}
}

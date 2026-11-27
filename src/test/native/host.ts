import { spawnSync } from "node:child_process"
import type { PremindHarness } from "../../shared/command-capabilities.ts"
import type { E2EEnvironment } from "./environment.ts"
import type { FakeModelOptions } from "./fake-model.ts"

/**
 * One coding-agent host under test. A driver installs the packed Premind
 * package the way a user would, launches the real host against the fake
 * model, and drives it only through the host's public interfaces.
 *
 * Shared scenarios use this interface; host-specific suites may also use the
 * concrete driver's extra evidence (for example OpenCode's synthetic message ids).
 */
export type HostDriver = {
	harness: PremindHarness
	/** Environment variable naming the host binary, e.g. `PREMIND_E2E_PI_BIN`. */
	binaryEnv: string
	/** Command to look up on PATH when `binaryEnv` is unset. */
	command: string
	/** Major versions this driver supports, checked against `--version`. */
	versionPattern: RegExp
	/** Model requests this host sends outside agent turns. */
	model?: FakeModelOptions
	start(e2e: E2EEnvironment, options: { binary: string; packageRoot: string }): Promise<HostInstance>
}

export type HostInstance = {
	/** Open a new primary session; the first `prompt` attaches it to Premind. */
	openSession(): Promise<HostSession>
	/** Restart the host process, keeping its sessions on disk. Hosts that run one
	 * process per session may stop here and relaunch in `resumeSession`. */
	restart(): Promise<void>
	/** Reopen a session after `restart`. */
	resumeSession(session: HostSession): Promise<HostSession>
	/** Recent host output for failure messages. */
	output(): string
	stop(): Promise<void>
}

export type HostSession = {
	/** Send a user message and wait until the turn it starts has finished. */
	prompt(text: string): Promise<void>
}

export type LocatedHost = { binary: string; version: string } | { missing: string }

/** CI sets this to a comma-separated list of harnesses (or `all`) that must run. */
export const REQUIRE_ENV = "PREMIND_E2E_REQUIRE"

export function locateHost(driver: HostDriver, parent: NodeJS.ProcessEnv = process.env): LocatedHost {
	const binary = parent[driver.binaryEnv] || driver.command
	const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 })
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
	const version = /(\d+\.\d+\.\d+\S*)/.exec(output)?.[1]
	const located: LocatedHost = result.error || result.status !== 0 || !version
		? { missing: `${driver.harness}: ${binary} is not runnable (${result.error?.message ?? output.trim().slice(0, 200)})` }
		: driver.versionPattern.test(version)
			? { binary, version }
			: { missing: `${driver.harness}: ${binary} ${version} is not a supported version` }
	if ("missing" in located && isRequired(driver.harness, parent)) {
		throw new Error(`${located.missing}, but ${REQUIRE_ENV} requires it`)
	}
	return located
}

const isRequired = (harness: PremindHarness, parent: NodeJS.ProcessEnv) => {
	const required = (parent[REQUIRE_ENV] ?? "").split(",").map((entry) => entry.trim())
	return required.includes("all") || required.includes(harness)
}

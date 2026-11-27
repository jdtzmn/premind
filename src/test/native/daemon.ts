import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PremindHarness } from "../../shared/command-capabilities.ts"
import { bootstrapResponseSchema } from "../../shared/protocol/bootstrap.ts"
import { PREMIND_COMMIT, PREMIND_VERSION } from "../../shared/version.ts"
import { nativeIpcRequest } from "./ipc.ts"
import { startNativeProcess } from "./process.ts"
import type { NativeSandbox } from "./sandbox.ts"

const repository = fileURLToPath(new URL("../../../", import.meta.url))

/** Real production daemon, socket and SQLite. No Router/StateStore replacement. */
export async function startNativeDaemon(sandbox: NativeSandbox) {
	const bin = path.join(sandbox.root, "bin")
	mkdirSync(bin, { recursive: true })
	// This infrastructure fixture cannot use personal gh credentials or contact
	// GitHub. Native delivery scenarios will supply a separate upstream fixture.
	writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
	const child = startNativeProcess({
		label: "production daemon",
		command: process.execPath,
		args: ["--import", import.meta.resolve("tsx"), path.join(repository, "src/daemon/index.ts")],
		cwd: sandbox.workspace,
		env: { ...sandbox.env, PATH: `${bin}${path.delimiter}${sandbox.env.PATH ?? ""}` },
	})
	try {
		await child.waitForOutput('"message":"listening"', 10_000)
	} catch (error) {
		await child.stop()
		throw error
	}
	return {
		process: child,
		stop: () => child.stop(2_000),
		bootstrap: async (host: PremindHarness) => {
			const response = bootstrapResponseSchema.parse(await nativeIpcRequest(sandbox.socket, {
				type: "initialize", bootstrapVersion: 1,
				payload: {
					client: { host, version: PREMIND_VERSION, commit: PREMIND_COMMIT, incarnationNonce: randomUUID() },
					protocols: { min: 1, max: 2 },
				},
			}))
			if (!response.ok) throw new Error(`Native bootstrap failed: ${response.error.code}`)
			return response.result
		},
		/** Explicit legacy proxy control; does not claim to emulate a native host. */
		legacyRequest: (type: string, payload: unknown) => nativeIpcRequest(sandbox.socket, { type, protocolVersion: 1, payload }),
	}
}

import { writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import type { E2EEnvironment } from "./environment.ts"
import type { HostDriver, HostInstance, HostSession } from "./host.ts"
import { startNativeProcess, type NativeProcess } from "./process.ts"

/** A running `opencode serve` plus the evidence OpenCode-only suites use. */
export type OpenCodeInstance = HostInstance & {
	/** Client for the current server, authenticated and bound to the workspace. */
	client(): OpenCodeClient
	/** Server output so far. */
	logs(): string
}

export type OpenCodeSession = HostSession & { id: string }

const freePort = () => new Promise<number>((resolve, reject) => {
	const server = net.createServer()
	server.once("error", reject)
	server.listen(0, "127.0.0.1", () => {
		const { port } = server.address() as net.AddressInfo
		server.close(() => resolve(port))
	})
})

/** The fake model as OpenCode's only provider, and the packed package loaded through its exports, as users install it. */
function configureOpenCode(workspace: string, modelUrl: string, plugin: string) {
	writeFileSync(path.join(workspace, "opencode.json"), `${JSON.stringify({
		$schema: "https://opencode.ai/config.json",
		model: "fake/premind-e2e",
		plugins: [plugin],
		providers: {
			fake: {
				name: "Fake",
				env: ["FAKE_API_KEY"],
				package: "@opencode/ai/providers/openai-compatible",
				settings: { baseURL: modelUrl },
				models: { "premind-e2e": { name: "Premind e2e" } },
			},
		},
	}, null, 2)}\n`)
}

export async function startOpenCode(e2e: E2EEnvironment, options: { binary: string; packageRoot: string }): Promise<OpenCodeInstance> {
	configureOpenCode(e2e.sandbox.workspace, e2e.model.url, options.packageRoot)
	const env: NodeJS.ProcessEnv = { ...e2e.env, FAKE_API_KEY: "premind-e2e" }
	let current: { process: NativeProcess; client: OpenCodeClient } | undefined
	let history = ""

	const launch = async () => {
		const port = await freePort()
		const process = startNativeProcess({
			label: "OpenCode", command: options.binary, cwd: e2e.sandbox.workspace, env, outputLimit: 262_144,
			args: ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"],
		})
		const output = () => process.output.stdout + process.output.stderr
		try {
			const password = await e2e.waitFor("OpenCode to print its server password", async () => {
				if (process.child.exitCode !== null) throw new Error(`OpenCode exited:\n${output().slice(-4000)}`)
				return /server password (\S+)/.exec(output())?.[1]
			}, 30_000)
			const client = OpenCode.make({
				baseUrl: `http://127.0.0.1:${port}`,
				headers: {
					authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
					"x-opencode-directory": e2e.sandbox.workspace,
				},
			})
			// The server prints its password before it accepts requests.
			await e2e.waitFor("OpenCode to accept requests", () => client.plugin.list().then(() => true, () => false), 30_000)
			current = { process, client }
		} catch (error) {
			history += output()
			await process.stop().catch(() => {})
			throw error
		}
	}

	const stop = async () => {
		if (!current) return
		const { process } = current
		current = undefined
		process.child.kill("SIGTERM")
		await Promise.race([process.exited, delay(10_000)])
		history += process.output.stdout + process.output.stderr
		await process.stop().catch(() => {})
	}

	const client = () => {
		if (!current) throw new Error("OpenCode is not running")
		return current.client
	}

	const session = (id: string): OpenCodeSession => ({
		id,
		async prompt(text) {
			const before = e2e.model.requests.length
			await client().session.prompt({ sessionID: id, text })
			await e2e.waitFor(`OpenCode to send ${JSON.stringify(text)} to the model`, () =>
				e2e.model.requests.slice(before).some((request) =>
					request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(text))))
			await client().experimental.session.wait({ sessionID: id })
		},
	})

	await launch()
	return {
		client,
		logs: () => history + (current ? current.process.output.stdout + current.process.output.stderr : ""),
		output: () => (history + (current ? current.process.output.stdout + current.process.output.stderr : "")).slice(-6000),
		async openSession() {
			const created = await client().session.create({ location: { directory: e2e.sandbox.workspace } })
			return session(created.id)
		},
		async restart() {
			await stop()
			await launch()
		},
		async resumeSession(previous) {
			return session((previous as OpenCodeSession).id)
		},
		stop,
	}
}

/**
 * Real `opencode serve` (V2). Premind is the packed package's V2 plugin
 * directory, loaded by path from the workspace's `opencode.json`.
 */
export const openCodeDriver: HostDriver = {
	harness: "opencode",
	binaryEnv: "PREMIND_E2E_OPENCODE_BIN",
	command: "opencode",
	versionPattern: /^2\./,
	model: {
		// Agent turns always offer tools; the session-title request does not.
		isAuxiliary: (request) => (request.tools?.length ? undefined : "Test session"),
	},
	start: startOpenCode,
}

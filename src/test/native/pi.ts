import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { E2EEnvironment } from "./environment.ts"
import type { HostDriver, HostSession } from "./host.ts"
import { nativeJsonl } from "./jsonl.ts"
import { startNativeProcess, type NativeProcess } from "./process.ts"

const PROVIDER = "premind-e2e"
const MODEL = "premind-e2e"

/** Sandboxed agent settings and the fake model as Pi's only provider. */
function configurePi(agentDir: string, modelUrl: string) {
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", cacheWarming: "off", compaction: { enabled: false },
		retry: { enabled: false, provider: { maxRetries: 0 } }, enableInstallTelemetry: false,
	}))
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
		[PROVIDER]: { baseUrl: modelUrl, api: "openai-completions", apiKey: "local-no-auth",
			models: [{ id: MODEL, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
			}],
		},
	} }))
}

/**
 * Real Pi in RPC mode. Premind is installed with `pi install <package>`, as
 * users install it, and Pi discovers it from the sandboxed agent directory.
 */
export const piDriver: HostDriver = {
	harness: "pi",
	binaryEnv: "PREMIND_E2E_PI_BIN",
	command: "pi",
	versionPattern: /^\d+\./,
	async start(e2e, { binary, packageRoot }) {
		const env: NodeJS.ProcessEnv = { ...e2e.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" }
		configurePi(env.PI_CODING_AGENT_DIR!, e2e.model.url)
		execFileSync(binary, ["install", packageRoot], { cwd: e2e.sandbox.workspace, env, stdio: ["ignore", "pipe", "pipe"] })
		const sessionDir = path.join(e2e.sandbox.root, "pi-sessions")
		let current: { process: NativeProcess; rpc: ReturnType<typeof nativeJsonl> } | undefined
		let history = ""

		const launch = async (sessionId: string) => {
			const process = startNativeProcess({
				label: "Pi", command: binary, cwd: e2e.sandbox.workspace, env, outputLimit: 65_536,
				args: ["--mode", "rpc", "--offline", "--no-approve", "--no-context-files", "--no-prompt-templates",
					"--no-themes", "--no-mcp", "--no-builtin-tools", "--provider", PROVIDER, "--model", MODEL,
					"--thinking", "off", "--session-dir", sessionDir, "--session-id", sessionId],
			})
			const rpc = nativeJsonl(process)
			try {
				await rpc.request({ type: "get_state" }, 30_000)
			} catch (error) {
				await process.stop()
				throw new Error(`Pi did not start: ${process.output.stderr}`, { cause: error })
			}
			current = { process, rpc }
		}
		const stop = async () => {
			if (!current) return
			const { process } = current
			current = undefined
			history += process.output.stderr
			process.child.stdin.end()
			await Promise.race([process.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
			await process.stop()
		}
		const session = (id: string): HostSession => ({
			async prompt(message) {
				if (!current) throw new Error("Pi is not running")
				const { rpc } = current
				const controller = new AbortController()
				const settled = rpc.waitFor((event) => event.type === "agent_settled", 60_000, controller.signal)
				void settled.catch(() => {})
				try {
					const accepted = await rpc.request({ type: "prompt", message }) as { disposition?: string } | undefined
					if (accepted?.disposition !== "started") throw new Error(`Pi did not start a turn for ${JSON.stringify(message)}`)
					if ((await settled).aborted) throw new Error("Pi aborted the turn")
				} finally {
					controller.abort()
				}
			},
			id,
		} as HostSession & { id: string })

		return {
			async openSession() {
				await stop()
				const id = `premind-e2e-${Date.now()}`
				await launch(id)
				return session(id)
			},
			async restart() {
				await stop()
			},
			async resumeSession(previous) {
				const id = (previous as HostSession & { id: string }).id
				await launch(id)
				return session(id)
			},
			output: () => history + (current?.process.output.stderr ?? ""),
			stop,
		}
	},
}

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { nativeJsonl } from "./jsonl.ts"
import { startNativeProcess } from "./process.ts"
import type { NativeSandbox } from "./sandbox.ts"

function configurePi(agent: string, providerUrl: string) {
	mkdirSync(agent, { recursive: true })
	writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", cacheWarming: "off", compaction: { enabled: false },
		retry: { enabled: false, provider: { maxRetries: 0 } }, enableInstallTelemetry: false,
	}))
	writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: {
		"native-local": { baseUrl: providerUrl, api: "openai-completions", apiKey: "local-no-auth",
			models: [{ id: "premind-native-fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
			}],
		},
	} }))
}

/** Actual installed Pi, controlled only through its public RPC protocol. */
export async function startNativePi(sandbox: NativeSandbox, options: {
	providerUrl: string
	extension?: string
	sessionFile?: string
	command?: string
}) {
	configurePi(sandbox.env.PI_CODING_AGENT_DIR!, options.providerUrl)
	const process = startNativeProcess({
		label: "native Pi", command: options.command ?? "pi", cwd: sandbox.workspace,
		env: { ...sandbox.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" },
		args: ["--mode", "rpc", "--offline", "--no-approve", "--no-context-files", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-themes", "--no-mcp", "--no-builtin-tools",
			"--provider", "native-local", "--model", "premind-native-fixture", "--thinking", "off",
			"--session-dir", path.join(sandbox.root, "sessions"),
			...(options.sessionFile ? ["--session", options.sessionFile] : ["--session-id", "native-pi-smoke"]),
			...(options.extension ? ["-e", options.extension] : []),
		],
	})
	const rpc = nativeJsonl(process)
	try { await rpc.request({ type: "get_state" }) }
	catch (error) { await process.stop(); throw new Error(`Native Pi startup failed: ${process.output.stderr}`, { cause: error }) }
	return {
		process, rpc,
		/** Model-starting prompts only. Commands use rpc.request directly. */
		async promptAndWait(message: string) {
			const controller = new AbortController()
			const settled = rpc.waitFor((event) => event.type === "agent_settled", 10_000, controller.signal)
			// Both acceptance and settlement can fail independently; attach a handler
			// before awaiting acceptance, while still surfacing settlement below.
			void settled.catch(() => {})
			try {
				const accepted = await rpc.request({ type: "prompt", message }) as { disposition?: string } | undefined
				if (accepted?.disposition === "handled") throw new Error("Native Pi prompt was handled without starting a model run")
				if (accepted?.disposition !== "started") throw new Error("Native Pi model prompt did not start immediately")
				if ((await settled).aborted) throw new Error("Native Pi turn aborted")
				return rpc.request({ type: "get_last_assistant_text" })
			} finally { controller.abort() }
		},
		async stop() {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				process.child.stdin.end()
				return await Promise.race([process.exited, new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Native Pi graceful shutdown timed out")), 3_000)
				})])
			} finally { clearTimeout(timer); await process.stop() }
		},
	}
}

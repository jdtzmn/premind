import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PremindDaemonClient } from "../client/daemon-client.ts";
import { createDaemonLauncher } from "../client/daemon-launcher.ts";
import { detectGitContext } from "../client/git-context.ts";
import { CODEX_REQUIRED_DAEMON_OPERATIONS } from "../shared/daemon-startup.ts";
import { acquireSessionLifecycleLock } from "./delivery-receipts.ts";
import { runCodexLifecycle } from "./lifecycle.ts";
import type { CodexHookEventName } from "./schemas.ts";
import { ensureCodexSessionBinding } from "./session-binding.ts";

const RUNTIME_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.join(RUNTIME_DIRECTORY, "premind-daemon.mjs");
const MAX_INPUT_BYTES = 1024 * 1024;
const CLEANUP_REQUEST_TIMEOUT_MS = 500;
const CLEANUP_LOCK_TIMEOUT_MS = 300;
const eventNames = new Set<CodexHookEventName>([
	"SessionStart",
	"UserPromptSubmit",
	"Stop",
	"Interrupt",
	"SessionEnd",
]);

export const readHookInput = async (
	input: NodeJS.ReadableStream,
): Promise<unknown> => {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of input) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > MAX_INPUT_BYTES) {
			throw new Error("Codex hook input exceeds the supported size");
		}
		chunks.push(buffer);
	}
	const serialized = Buffer.concat(chunks).toString("utf8");
	if (!serialized.trim()) throw new Error("Codex hook input is empty");
	try {
		return JSON.parse(serialized);
	} catch (error) {
		throw new Error("Codex hook input is not valid JSON", { cause: error });
	}
};

export const flushProtocolOutput = async (
	output: NodeJS.WritableStream,
	value: string,
) => {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			output.removeListener("error", onError);
			if (error) reject(error);
			else resolve();
		};
		const onError = (error: Error) => finish(error);
		output.once("error", onError);
		output.write(value, () => finish());
	});
};

const isEventName = (value: string | undefined): value is CodexHookEventName =>
	eventNames.has(value as CodexHookEventName);

const writeDiagnostic = (
	output: NodeJS.WritableStream,
	eventName: string,
	stage: string,
) => {
	output.write(
		`premind Codex ${eventName} hook failed during ${stage}; continuing\n`,
	);
};

export const runHookMain = async (
	options: {
		eventName?: string;
		environment?: NodeJS.ProcessEnv;
		input?: NodeJS.ReadableStream;
		output?: NodeJS.WritableStream;
		diagnostics?: NodeJS.WritableStream;
	} = {},
) => {
	const eventName = options.eventName ?? process.argv[2];
	const environment = options.environment ?? process.env;
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const diagnostics = options.diagnostics ?? process.stderr;
	if (!isEventName(eventName)) {
		writeDiagnostic(diagnostics, "unknown", "event validation");
		return;
	}

	try {
		const rawInput = await readHookInput(input);
		const ensureDaemon = createDaemonLauncher({
			daemonEntry: DAEMON_ENTRY,
			requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
		});
		const client = new PremindDaemonClient({ ensureDaemon });
		const cleanupClient = new PremindDaemonClient({
			ensureDaemon: async () => undefined,
			maxRetries: 0,
			requestTimeoutMs: CLEANUP_REQUEST_TIMEOUT_MS,
		});
		const pluginData = environment.PLUGIN_DATA;
		await runCodexLifecycle(eventName, rawInput, {
			client,
			cleanupClient,
			ensureDaemon,
			detectGitContext,
			acquireLock: async (sessionId, cleanupBoundary) => {
				if (!pluginData) throw new Error("PLUGIN_DATA is required");
				return await acquireSessionLifecycleLock(pluginData, sessionId, {
					...(cleanupBoundary ? { timeoutMs: CLEANUP_LOCK_TIMEOUT_MS } : {}),
				});
			},
			ensureSessionBinding: async (sessionId, cwd) => {
				if (!pluginData) throw new Error("PLUGIN_DATA is required");
				return ensureCodexSessionBinding(pluginData, sessionId, cwd);
			},
			writeOutput: async (value) => {
				await flushProtocolOutput(output, value);
			},
			reportError: (failedEvent, stage) =>
				writeDiagnostic(diagnostics, failedEvent, stage),
		});
	} catch {
		writeDiagnostic(diagnostics, eventName, "runner setup");
		if (eventName !== "SessionEnd") {
			await flushProtocolOutput(output, "{}\n").catch(() => undefined);
		}
	}
};

const isMainModule = () => {
	if (!process.argv[1]) return false;
	try {
		return (
			fs.realpathSync(process.argv[1]) ===
			fs.realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
};
if (isMainModule()) {
	void runHookMain().catch(() => {
		process.exitCode = 0;
	});
}

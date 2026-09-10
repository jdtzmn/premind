import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
	ClaimReminderPayload,
	ReminderClaim,
	SettleReminderClaimPayload,
} from "../../shared/schema.ts";
import type { SessionLifecycleLock } from "../delivery-receipts.ts";
import {
	type CodexDaemonClient,
	type CodexLifecycleDependencies,
	runCodexLifecycle,
} from "../lifecycle.ts";
import type { CodexDeliveryReceipt } from "../schemas.ts";

const common = {
	session_id: "thread-1",
	transcript_path: null,
	cwd: "/repo",
	model: "gpt-test",
	permission_mode: "default" as const,
};

const startInput = (
	source: "startup" | "resume" | "clear" | "compact" = "startup",
) => ({
	...common,
	hook_event_name: "SessionStart" as const,
	source,
});

const promptInput = (turnId = "turn-1") => ({
	...common,
	hook_event_name: "UserPromptSubmit" as const,
	turn_id: turnId,
	prompt: "sensitive prompt",
});

const stopInput = (turnId = "turn-1", stopHookActive = false) => ({
	...common,
	hook_event_name: "Stop" as const,
	turn_id: turnId,
	stop_hook_active: stopHookActive,
	last_assistant_message: "sensitive assistant text",
});
const sessionEndInput = () => {
	const { permission_mode: _permissionMode, ...sessionFields } = common;
	return {
		...sessionFields,
		hook_event_name: "SessionEnd" as const,
		reason: "other" as const,
	};
};

const claim = (
	boundarySessionId = "codex:thread-1",
	reminderText = "PR #42 changed",
): ReminderClaim => ({
	batch: {
		batchId: "batch-1",
		sessionId: boundarySessionId,
		repo: "acme/repo",
		prNumber: 42,
		reminderText,
		events: [],
	},
	handoffId: "00000000-0000-4000-8000-000000000001",
	leaseExpiresAt: 1_000,
});

type Harness = ReturnType<typeof createHarness>;

const createHarness = (
	options: {
		claims?: Array<ReminderClaim | null>;
		receipts?: CodexDeliveryReceipt[];
		writeOutput?: (output: string) => Promise<void>;
		publishError?: Error;
		sessionActive?: boolean;
		cleanupClient?: CodexDaemonClient;
	} = {},
) => {
	const calls: Array<{ type: string; payload?: unknown }> = [];
	const settlements: SettleReminderClaimPayload[] = [];
	const registrations: unknown[] = [];
	const published: CodexDeliveryReceipt[] = [];
	const deleted: CodexDeliveryReceipt[] = [];
	const outputs: string[] = [];
	const queuedClaims = [...(options.claims ?? [null])];
	let released = false;
	const lock: SessionLifecycleLock = {
		listReceipts: () => [...(options.receipts ?? [])],
		compareAndDeleteReceipt(receipt) {
			deleted.push(receipt);
			return true;
		},
		publishReceipt(receipt) {
			calls.push({ type: "publish", payload: receipt });
			if (options.publishError) throw options.publishError;
			published.push(receipt);
			released = true;
		},
		release() {
			calls.push({ type: "release" });
			released = true;
		},
	};
	const client: CodexDaemonClient = {
		async registerCodexSession(payload) {
			calls.push({ type: "register", payload });
			registrations.push(payload);
			return { active: options.sessionActive ?? true };
		},
		async claimReminder(payload: ClaimReminderPayload) {
			calls.push({ type: "claim", payload });
			return { claim: queuedClaims.shift() ?? null };
		},
		async settleReminderClaim(payload) {
			calls.push({ type: "settle", payload });
			settlements.push(payload);
			return { settled: true };
		},
		async releaseSessionOwner(sessionId) {
			calls.push({ type: "release-owner", payload: sessionId });
		},
		async updateSessionState(payload) {
			calls.push({ type: "update", payload });
		},
		async activateWorktree(payload) {
			calls.push({ type: "activate", payload });
		},
	};
	const dependencies: CodexLifecycleDependencies = {
		client,
		cleanupClient: options.cleanupClient,
		async ensureDaemon() {
			calls.push({ type: "ensure" });
		},
		async detectGitContext(cwd) {
			calls.push({ type: "git", payload: cwd });
			return { repo: "acme/repo", branch: "feature/codex" };
		},
		async acquireLock(sessionId, cleanupBoundary) {
			calls.push({ type: "lock", payload: { sessionId, cleanupBoundary } });
			return lock;
		},
		async writeOutput(output) {
			calls.push({ type: "write", payload: output });
			outputs.push(output);
			await options.writeOutput?.(output);
		},
		now: () => 100,
	};
	return {
		calls,
		client,
		dependencies,
		deleted,
		lock,
		outputs,
		published,
		registrations,
		settlements,
		isReleased: () => released,
	};
};

const callTypes = (harness: Harness) => harness.calls.map((call) => call.type);

describe("Codex lifecycle adapter", () => {
	test("registers a namespaced start, activates cwd, flushes context, then publishes evidence", async () => {
		const harness = createHarness({ claims: [claim()] });
		await runCodexLifecycle(
			"SessionStart",
			startInput("resume"),
			harness.dependencies,
		);

		assert.deepEqual(harness.registrations, [
			{
				sessionId: "codex:thread-1",
				hostSessionId: "thread-1",
				repo: "acme/repo",
				branch: "feature/codex",
				busyState: "idle",
				reactivate: true,
			},
		]);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: "PR #42 changed",
			},
		});
		assert.equal(harness.published[0]?.boundary, "session_start");
		assert.ok(
			callTypes(harness).indexOf("write") <
				callTypes(harness).indexOf("publish"),
		);
		assert.equal(callTypes(harness).includes("activate"), true);
	});

	test("reconciles compact starts without reactivation, worktree activation, or delivery", async () => {
		const harness = createHarness({ claims: [claim()] });
		await runCodexLifecycle(
			"SessionStart",
			startInput("compact"),
			harness.dependencies,
		);

		assert.equal(
			(harness.registrations[0] as { reactivate: boolean }).reactivate,
			false,
		);
		assert.equal(callTypes(harness).includes("activate"), false);
		assert.equal(callTypes(harness).includes("claim"), false);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {});
		assert.ok(
			callTypes(harness).indexOf("release") <
				callTypes(harness).indexOf("write"),
		);
	});

	test("marks prompts busy and correlates their receipts by turn id", async () => {
		const harness = createHarness({ claims: [claim()] });
		await runCodexLifecycle(
			"UserPromptSubmit",
			promptInput("turn-7"),
			harness.dependencies,
		);

		assert.deepEqual(
			harness.calls.find((call) => call.type === "update")?.payload,
			{ sessionId: "codex:thread-1", busyState: "busy" },
		);
		assert.equal(harness.published[0]?.boundary, "user_prompt_submit");
		assert.equal(harness.published[0]?.sourceTurnId, "turn-7");
		assert.equal(
			JSON.stringify(harness.published).includes("sensitive prompt"),
			false,
		);
	});

	test("confirms only root-stop proof and leaves unrelated receipts untouched", async () => {
		const baseReceipt = {
			sessionId: "codex:thread-1",
			outputFlushedAt: 50,
			leaseExpiresAt: 1_000,
		} as const;
		const receipts: CodexDeliveryReceipt[] = [
			{
				...baseReceipt,
				batchId: "batch-start",
				handoffId: "00000000-0000-4000-8000-000000000002",
				boundary: "session_start",
			},
			{
				...baseReceipt,
				batchId: "batch-prompt",
				handoffId: "00000000-0000-4000-8000-000000000003",
				boundary: "user_prompt_submit",
				sourceTurnId: "turn-1",
			},
			{
				...baseReceipt,
				batchId: "batch-other-prompt",
				handoffId: "00000000-0000-4000-8000-000000000004",
				boundary: "user_prompt_submit",
				sourceTurnId: "turn-other",
			},
			{
				...baseReceipt,
				batchId: "batch-stop",
				handoffId: "00000000-0000-4000-8000-000000000005",
				boundary: "stop",
			},
		];
		const harness = createHarness({ receipts, claims: [null] });
		await runCodexLifecycle(
			"Stop",
			stopInput("turn-1", false),
			harness.dependencies,
		);

		assert.deepEqual(
			harness.settlements.map((settlement) => settlement.batchId).sort(),
			["batch-prompt", "batch-start"],
		);
		assert.deepEqual(harness.deleted.map((receipt) => receipt.batchId).sort(), [
			"batch-prompt",
			"batch-start",
		]);
		assert.equal(callTypes(harness).includes("claim"), true);
	});

	test("reconciles expired receipts as failed without confirming them", async () => {
		const expired: CodexDeliveryReceipt = {
			sessionId: "codex:thread-1",
			batchId: "batch-expired",
			handoffId: "00000000-0000-4000-8000-000000000006",
			boundary: "user_prompt_submit",
			sourceTurnId: "turn-old",
			outputFlushedAt: 10,
			leaseExpiresAt: 99,
		};
		const harness = createHarness({ receipts: [expired], claims: [null] });
		await runCodexLifecycle(
			"UserPromptSubmit",
			promptInput("turn-new"),
			harness.dependencies,
		);
		assert.equal(harness.settlements[0]?.outcome, "failed");
		assert.equal(harness.deleted[0]?.handoffId, expired.handoffId);
	});

	test("does not revive or claim from a dormant session on delayed Stop", async () => {
		const harness = createHarness({
			sessionActive: false,
			claims: [claim()],
		});
		await runCodexLifecycle("Stop", stopInput(), harness.dependencies);
		assert.equal(callTypes(harness).includes("state"), false);
		assert.equal(callTypes(harness).includes("claim"), false);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {});
	});

	test("continuation Stop confirms its Stop receipt and never claims another batch", async () => {
		const receipt: CodexDeliveryReceipt = {
			sessionId: "codex:thread-1",
			batchId: "batch-stop",
			handoffId: "00000000-0000-4000-8000-000000000005",
			boundary: "stop",
			outputFlushedAt: 50,
			leaseExpiresAt: 1_000,
		};
		const harness = createHarness({ receipts: [receipt], claims: [claim()] });
		await runCodexLifecycle(
			"Stop",
			stopInput("turn-2", true),
			harness.dependencies,
		);

		assert.equal(harness.settlements[0]?.batchId, "batch-stop");
		assert.equal(callTypes(harness).includes("claim"), false);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {});
	});

	test("requests exactly one Stop continuation for a newly claimed reminder", async () => {
		const harness = createHarness({ claims: [claim()] });
		await runCodexLifecycle("Stop", stopInput(), harness.dependencies);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {
			decision: "block",
			reason: "PR #42 changed",
		});
		assert.equal(harness.published[0]?.boundary, "stop");
	});

	test("fails open before output and settles the claim for retry", async () => {
		const harness = createHarness({
			claims: [claim()],
			writeOutput: async () => {
				throw new Error("stdout failed");
			},
		});
		await runCodexLifecycle("Stop", stopInput(), harness.dependencies);
		assert.equal(harness.settlements[0]?.outcome, "failed");
		assert.equal(harness.published.length, 0);
	});

	test("does no daemon settlement after output flush when receipt publication fails", async () => {
		const harness = createHarness({
			claims: [claim()],
			publishError: new Error("disk full"),
		});
		await runCodexLifecycle("Stop", stopInput(), harness.dependencies);
		assert.equal(harness.outputs.length, 1);
		assert.equal(harness.settlements.length, 0);
		assert.deepEqual(callTypes(harness).slice(-2), ["write", "publish"]);
	});

	test("truncates oversized reminders to protocol-safe bounded output", async () => {
		const harness = createHarness({
			claims: [claim("codex:thread-1", "x".repeat(400_000))],
		});
		await runCodexLifecycle("Stop", stopInput(), harness.dependencies);
		assert.ok(Buffer.byteLength(harness.outputs[0], "utf8") < 250 * 1024);
		assert.match(JSON.parse(harness.outputs[0]).reason, /premind truncated/);
	});

	test("keeps daemon startup failure fail-open before side effects", async () => {
		const harness = createHarness({ claims: [claim()] });
		harness.dependencies.ensureDaemon = async () => {
			throw new Error("daemon unavailable");
		};
		await runCodexLifecycle("SessionStart", startInput(), harness.dependencies);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {});
		assert.equal(callTypes(harness).includes("register"), false);
		assert.equal(callTypes(harness).includes("claim"), false);
	});

	test("keeps malformed input fail-open without persisting sensitive fields", async () => {
		const harness = createHarness();
		const stages: string[] = [];
		harness.dependencies.reportError = (_eventName, stage) =>
			stages.push(stage);
		await runCodexLifecycle(
			"UserPromptSubmit",
			{ ...promptInput(), unknown: "secret" },
			harness.dependencies,
		);
		assert.deepEqual(JSON.parse(harness.outputs[0]), {});
		assert.deepEqual(stages, ["validation"]);
		assert.equal(JSON.stringify(harness.calls).includes("secret"), false);
	});

	test("uses bounded cleanup paths for Interrupt and non-destructive SessionEnd", async () => {
		const interruptHarness = createHarness();
		interruptHarness.dependencies.cleanupTimeoutMs = 20;
		interruptHarness.dependencies.cleanupClient = {
			...interruptHarness.client,
			updateSessionState: async () => await new Promise(() => undefined),
		};
		const startedAt = Date.now();
		await runCodexLifecycle(
			"Interrupt",
			{
				...common,
				hook_event_name: "Interrupt",
				turn_id: "turn-1",
			},
			interruptHarness.dependencies,
		);
		assert.ok(Date.now() - startedAt < 200);
		assert.deepEqual(JSON.parse(interruptHarness.outputs[0]), {});

		const endHarness = createHarness();
		await runCodexLifecycle(
			"SessionEnd",
			sessionEndInput(),
			endHarness.dependencies,
		);
		assert.equal(callTypes(endHarness).includes("release-owner"), true);
		assert.equal(callTypes(endHarness).includes("register"), false);
		assert.equal(endHarness.outputs.length, 0);
	});
});

import type {
	ClaimReminderPayload,
	CodexSessionPayload,
	ReminderClaim,
	SettleReminderClaimPayload,
	UpdateSessionStatePayload,
} from "../shared/schema.ts";
import type { SessionLifecycleLock } from "./delivery-receipts.ts";
import type {
	CodexDeliveryReceipt,
	CodexHookEventName,
	CodexHookInput,
	SessionStartInput,
	StopInput,
	UserPromptSubmitInput,
} from "./schemas.ts";
import {
	codexHookInputSchema,
	interruptInputSchema,
	noOpOutputSchema,
	sessionEndInputSchema,
	sessionStartInputSchema,
	sessionStartOutputSchema,
	stopInputSchema,
	stopOutputSchema,
	userPromptSubmitInputSchema,
	userPromptSubmitOutputSchema,
} from "./schemas.ts";

const MAX_REMINDER_BYTES = 240 * 1024;
const TRUNCATION_SUFFIX =
	"\n\n[premind truncated this reminder to fit the Codex hook response]";

export type CodexDaemonClient = {
	registerCodexSession(payload: CodexSessionPayload): Promise<{
		active?: boolean;
	}>;
	claimReminder(payload: ClaimReminderPayload): Promise<{
		claim: ReminderClaim | null;
	}>;
	settleReminderClaim(payload: SettleReminderClaimPayload): Promise<{
		settled: boolean;
	}>;
	releaseSessionOwner(sessionId: string): Promise<unknown>;
	updateSessionState(payload: UpdateSessionStatePayload): Promise<unknown>;
	activateWorktree(payload: {
		sessionId: string;
		path: string;
	}): Promise<unknown>;
};

export type CodexLifecycleDependencies = {
	client: CodexDaemonClient;
	cleanupClient?: CodexDaemonClient;
	ensureDaemon(): Promise<void>;
	detectGitContext(cwd: string): Promise<{ repo: string; branch: string }>;
	acquireLock(
		sessionId: string,
		cleanupBoundary: boolean,
	): Promise<SessionLifecycleLock>;
	writeOutput(output: string): Promise<void>;
	now?: () => number;
	reportError?: (eventName: string, stage: string) => void;
	cleanupTimeoutMs?: number;
};

const namespacedSessionId = (hostSessionId: string) => `codex:${hostSessionId}`;
const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number) => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Codex cleanup exceeded ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const truncateReminder = (text: string) => {
	if (Buffer.byteLength(text, "utf8") <= MAX_REMINDER_BYTES) return text;
	const budget =
		MAX_REMINDER_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	const prefix = Buffer.from(text, "utf8")
		.subarray(0, budget)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
	return `${prefix}${TRUNCATION_SUFFIX}`;
};

const parseInput = (
	eventName: CodexHookEventName,
	rawInput: unknown,
): CodexHookInput => {
	switch (eventName) {
		case "SessionStart":
			return sessionStartInputSchema.parse(rawInput);
		case "UserPromptSubmit":
			return userPromptSubmitInputSchema.parse(rawInput);
		case "Stop":
			return stopInputSchema.parse(rawInput);
		case "Interrupt":
			return interruptInputSchema.parse(rawInput);
		case "SessionEnd":
			return sessionEndInputSchema.parse(rawInput);
	}
};

const contextOutput = (
	eventName: "SessionStart" | "UserPromptSubmit",
	reminderText: string,
) => {
	const output = {
		hookSpecificOutput: {
			hookEventName: eventName,
			additionalContext: truncateReminder(reminderText),
		},
	};
	return eventName === "SessionStart"
		? sessionStartOutputSchema.parse(output)
		: userPromptSubmitOutputSchema.parse(output);
};

const stopOutput = (reminderText: string) =>
	stopOutputSchema.parse({
		decision: "block",
		reason: truncateReminder(reminderText),
	});

const isReceiptProven = (receipt: CodexDeliveryReceipt, input: StopInput) => {
	switch (receipt.boundary) {
		case "session_start":
			return input.stop_hook_active === false;
		case "user_prompt_submit":
			return receipt.sourceTurnId === input.turn_id;
		case "stop":
			return input.stop_hook_active === true;
	}
};

const reconcileReceipts = async (
	client: CodexDaemonClient,
	lock: SessionLifecycleLock,
	now: number,
	stopInput?: StopInput,
) => {
	for (const receipt of lock.listReceipts()) {
		const expired = receipt.leaseExpiresAt <= now;
		const proven = stopInput ? isReceiptProven(receipt, stopInput) : false;
		if (!expired && !proven) continue;
		try {
			const result = await client.settleReminderClaim({
				sessionId: receipt.sessionId,
				batchId: receipt.batchId,
				handoffId: receipt.handoffId,
				outcome: proven ? "confirmed" : "failed",
				...(proven ? {} : { failureReason: "Codex delivery receipt expired" }),
			});
			if (result.settled || expired) lock.compareAndDeleteReceipt(receipt);
		} catch {
			// Keep evidence when the daemon cannot settle it. A later boundary can
			// retry, and the daemon lease remains the source of truth.
		}
	}
};

const registerSession = async (
	dependencies: CodexLifecycleDependencies,
	input: SessionStartInput | UserPromptSubmitInput | StopInput,
	busyState: "busy" | "idle",
	reactivate = true,
) => {
	const git = await dependencies.detectGitContext(input.cwd);
	const sessionId = namespacedSessionId(input.session_id);
	const registration = await dependencies.client.registerCodexSession({
		sessionId,
		hostSessionId: input.session_id,
		repo: git.repo,
		branch: git.branch,
		busyState,
		reactivate,
	});
	return { sessionId, active: registration.active ?? true };
};

const emitClaim = async (
	dependencies: CodexLifecycleDependencies,
	lock: SessionLifecycleLock,
	eventName: "SessionStart" | "UserPromptSubmit" | "Stop",
	claim: ReminderClaim,
	now: () => number,
	expectedSessionId: string,
	onFlushed: () => void,
	sourceTurnId?: string,
) => {
	if (claim.batch.sessionId !== expectedSessionId) {
		throw new Error("Codex reminder claim belongs to another session");
	}
	const output =
		eventName === "Stop"
			? stopOutput(claim.batch.reminderText)
			: contextOutput(eventName, claim.batch.reminderText);
	const serialized = `${JSON.stringify(output)}\n`;
	await dependencies.writeOutput(serialized);
	onFlushed();
	lock.publishReceipt({
		sessionId: claim.batch.sessionId,
		batchId: claim.batch.batchId,
		handoffId: claim.handoffId,
		boundary:
			eventName === "SessionStart"
				? "session_start"
				: eventName === "UserPromptSubmit"
					? "user_prompt_submit"
					: "stop",
		...(sourceTurnId ? { sourceTurnId } : {}),
		outputFlushedAt: now(),
		leaseExpiresAt: claim.leaseExpiresAt,
	});
};

const writeNoOp = async (dependencies: CodexLifecycleDependencies) => {
	await dependencies.writeOutput(
		`${JSON.stringify(noOpOutputSchema.parse({}))}\n`,
	);
};

const handleDeliveryBoundary = async (
	dependencies: CodexLifecycleDependencies,
	input: SessionStartInput | UserPromptSubmitInput | StopInput,
) => {
	const eventName = input.hook_event_name;
	if (eventName === "SessionStart") await dependencies.ensureDaemon();
	const initialBusyState = eventName === "UserPromptSubmit" ? "busy" : "idle";
	const { sessionId, active: sessionActive } = await registerSession(
		dependencies,
		input,
		initialBusyState,
		eventName === "UserPromptSubmit" ||
			(eventName === "SessionStart" && input.source !== "compact"),
	);
	const lock = await dependencies.acquireLock(sessionId, false);
	let outputAttempted = false;
	let outputFlushed = false;
	let activeClaim: ReminderClaim | undefined;
	try {
		await reconcileReceipts(
			dependencies.client,
			lock,
			(dependencies.now ?? Date.now)(),
			eventName === "Stop" ? input : undefined,
		);

		if (eventName === "SessionStart") {
			if (input.source !== "compact") {
				await dependencies.client.activateWorktree({
					sessionId,
					path: input.cwd,
				});
			}
			if (input.source === "compact") {
				lock.release();
				outputAttempted = true;
				await writeNoOp(dependencies);
				outputFlushed = true;
				return;
			}
		} else if (eventName === "UserPromptSubmit") {
			await dependencies.client.updateSessionState({
				sessionId,
				busyState: "busy",
			});
		} else {
			if (!sessionActive) {
				lock.release();
				outputAttempted = true;
				await writeNoOp(dependencies);
				outputFlushed = true;
				return;
			}
			await dependencies.client.updateSessionState({
				sessionId,
				busyState: "idle",
			});
			if (input.stop_hook_active) {
				lock.release();
				outputAttempted = true;
				await writeNoOp(dependencies);
				outputFlushed = true;
				return;
			}
		}

		const boundary =
			eventName === "SessionStart"
				? "session_start"
				: eventName === "UserPromptSubmit"
					? "user_prompt_submit"
					: "stop";
		activeClaim =
			(await dependencies.client.claimReminder({ sessionId, boundary }))
				.claim ?? undefined;
		if (!activeClaim) {
			lock.release();
			outputAttempted = true;
			await writeNoOp(dependencies);
			outputFlushed = true;
			return;
		}

		outputAttempted = true;
		await emitClaim(
			dependencies,
			lock,
			eventName,
			activeClaim,
			dependencies.now ?? Date.now,
			sessionId,
			() => {
				outputFlushed = true;
			},
			eventName === "UserPromptSubmit" ? input.turn_id : undefined,
		);
		return;
	} catch {
		dependencies.reportError?.(eventName, "delivery");
		if (!outputFlushed && activeClaim) {
			try {
				await dependencies.client.settleReminderClaim({
					sessionId,
					batchId: activeClaim.batch.batchId,
					handoffId: activeClaim.handoffId,
					outcome: "failed",
					failureReason: "Codex hook failed before output flush",
				});
			} catch {
				// Lease expiry provides the retry path when settlement is unavailable.
			}
		}
		if (!outputAttempted) {
			outputAttempted = true;
			try {
				await writeNoOp(dependencies);
				outputFlushed = true;
			} catch {
				// A broken stdout cannot be recovered with another protocol write.
			}
		}
	} finally {
		// Receipt publication releases the SQLite owner before its final atomic
		// rename, so no fallible work follows visible evidence. Post-flush failures
		// rely on the daemon claim lease and dead-owner recovery, not cleanup I/O.
		if (!outputFlushed) {
			try {
				lock.release();
			} catch {
				// Fail open; stale-lock recovery is bounded.
			}
		}
	}
};

const handleCleanupBoundary = async (
	dependencies: CodexLifecycleDependencies,
	input: Extract<
		CodexHookInput,
		{ hook_event_name: "Interrupt" | "SessionEnd" }
	>,
) => {
	const sessionId = namespacedSessionId(input.session_id);
	const client = dependencies.cleanupClient ?? dependencies.client;
	let lock: SessionLifecycleLock | undefined;
	let outputAttempted = false;
	try {
		lock = await dependencies.acquireLock(sessionId, true);
		const operation =
			input.hook_event_name === "Interrupt"
				? client.updateSessionState({ sessionId, busyState: "idle" })
				: client.releaseSessionOwner(sessionId);
		await withTimeout(operation, dependencies.cleanupTimeoutMs ?? 750);
		if (input.hook_event_name === "Interrupt") {
			outputAttempted = true;
			await writeNoOp(dependencies);
		}
	} catch {
		dependencies.reportError?.(input.hook_event_name, "cleanup");
		if (input.hook_event_name === "Interrupt" && !outputAttempted) {
			await writeNoOp(dependencies).catch(() => undefined);
		}
	} finally {
		try {
			lock?.release();
		} catch {
			// Cleanup hooks are advisory and must remain fail-open.
		}
	}
};

export const runCodexLifecycle = async (
	eventName: CodexHookEventName,
	rawInput: unknown,
	dependencies: CodexLifecycleDependencies,
) => {
	let input: CodexHookInput;
	try {
		input = parseInput(eventName, rawInput);
		codexHookInputSchema.parse(input);
	} catch {
		dependencies.reportError?.(eventName, "validation");
		if (eventName !== "SessionEnd") {
			await writeNoOp(dependencies).catch(() => undefined);
		}
		return;
	}

	try {
		if (
			input.hook_event_name === "Interrupt" ||
			input.hook_event_name === "SessionEnd"
		) {
			await handleCleanupBoundary(dependencies, input);
			return;
		}
		await handleDeliveryBoundary(dependencies, input);
	} catch {
		dependencies.reportError?.(eventName, "setup");
		if (eventName !== "SessionEnd") {
			await writeNoOp(dependencies).catch(() => undefined);
		}
	}
};

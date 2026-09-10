import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Router } from "../../daemon/ipc/router.ts";
import { StateStore } from "../../daemon/persistence/store.ts";
import { PREMIND_PROTOCOL_VERSION } from "../../shared/constants.ts";
import {
	claimReminderResponseSchema,
	registerSessionResponseSchema,
	settleReminderClaimResponseSchema,
} from "../../shared/ipc.ts";
import type {
	ClaimReminderPayload,
	CodexSessionPayload,
	SettleReminderClaimPayload,
	UpdateSessionStatePayload,
} from "../../shared/schema.ts";
import { acquireSessionLifecycleLock } from "../delivery-receipts.ts";
import { type CodexDaemonClient, runCodexLifecycle } from "../lifecycle.ts";

const successfulResult = async (response: ReturnType<Router["handle"]>) => {
	const resolved = await response;
	if (!resolved.ok)
		throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
	return resolved.result;
};

test("Codex lifecycle delivers and confirms a real daemon claim", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-integration-"),
	);
	const store = new StateStore(path.join(directory, "premind.db"));
	const router = new Router(store);
	const sessionId = "codex:thread-1";
	const session: CodexSessionPayload = {
		sessionId,
		hostSessionId: "thread-1",
		repo: "acme/repo",
		branch: "feature/codex",
		busyState: "idle",
	};
	const client: CodexDaemonClient = {
		async registerCodexSession(payload) {
			return registerSessionResponseSchema.parse(
				await successfulResult(
					router.handle({
						type: "registerCodexSession",
						protocolVersion: PREMIND_PROTOCOL_VERSION,
						payload,
					}),
				),
			);
		},
		async claimReminder(payload: ClaimReminderPayload) {
			return claimReminderResponseSchema.parse(
				await successfulResult(
					router.handle({
						type: "claimReminder",
						protocolVersion: PREMIND_PROTOCOL_VERSION,
						payload,
					}),
				),
			);
		},
		async settleReminderClaim(payload: SettleReminderClaimPayload) {
			return settleReminderClaimResponseSchema.parse(
				await successfulResult(
					router.handle({
						type: "settleReminderClaim",
						protocolVersion: PREMIND_PROTOCOL_VERSION,
						payload,
					}),
				),
			);
		},
		async releaseSessionOwner(targetSessionId) {
			return await successfulResult(
				router.handle({
					type: "releaseSessionOwner",
					protocolVersion: PREMIND_PROTOCOL_VERSION,
					payload: { sessionId: targetSessionId },
				}),
			);
		},
		async updateSessionState(payload: UpdateSessionStatePayload) {
			return await successfulResult(
				router.handle({
					type: "updateSessionState",
					protocolVersion: PREMIND_PROTOCOL_VERSION,
					payload,
				}),
			);
		},
		async activateWorktree() {
			return { activated: true };
		},
	};
	const outputs: string[] = [];
	const dependencies = {
		client,
		ensureDaemon: async () => undefined,
		detectGitContext: async () => ({
			repo: session.repo,
			branch: session.branch,
		}),
		acquireLock: async (targetSessionId: string, cleanupBoundary: boolean) =>
			await acquireSessionLifecycleLock(directory, targetSessionId, {
				...(cleanupBoundary ? { timeoutMs: 100 } : {}),
			}),
		writeOutput: async (output: string) => {
			outputs.push(output);
		},
		now: () => 100,
	};

	try {
		await client.registerCodexSession(session);
		const subscription = store.upsertSubscription({
			sessionId,
			repo: session.repo,
			prNumber: 42,
			source: "manual",
		});
		const batchId = store.createOrReplaceReminder(
			sessionId,
			subscription.subscriptionId,
			"Review PR #42 changes",
			[],
			0,
			1,
		);

		await runCodexLifecycle(
			"SessionStart",
			{
				session_id: "thread-1",
				transcript_path: null,
				cwd: directory,
				hook_event_name: "SessionStart",
				model: "gpt-test",
				permission_mode: "default",
				source: "resume",
			},
			dependencies,
		);
		assert.match(
			JSON.parse(outputs[0]).hookSpecificOutput.additionalContext,
			/PR update for acme\/repo#42/,
		);
		assert.equal(
			store.getReminderBatchRecord(batchId, sessionId)?.state,
			"handed_off",
		);

		await runCodexLifecycle(
			"Stop",
			{
				session_id: "thread-1",
				transcript_path: null,
				cwd: directory,
				hook_event_name: "Stop",
				model: "gpt-test",
				permission_mode: "default",
				turn_id: "turn-1",
				stop_hook_active: false,
				last_assistant_message: null,
			},
			dependencies,
		);
		assert.deepEqual(JSON.parse(outputs[1]), {});
		assert.equal(store.getReminderBatchRecord(batchId, sessionId), null);

		await runCodexLifecycle(
			"SessionEnd",
			{
				session_id: "thread-1",
				transcript_path: null,
				cwd: directory,
				hook_event_name: "SessionEnd",
				model: "gpt-test",
				reason: "other",
			},
			dependencies,
		);
		assert.equal(store.getSession(sessionId)?.status, "dormant");
		assert.ok(store.getSubscription(sessionId, session.repo, 42));

		const delayedBatchId = store.createOrReplaceReminder(
			sessionId,
			subscription.subscriptionId,
			"Delayed reminder",
			[],
			1,
			2,
		);
		await runCodexLifecycle(
			"Stop",
			{
				session_id: "thread-1",
				transcript_path: null,
				cwd: directory,
				hook_event_name: "Stop",
				model: "gpt-test",
				permission_mode: "default",
				turn_id: "turn-delayed",
				stop_hook_active: false,
				last_assistant_message: null,
			},
			dependencies,
		);
		assert.deepEqual(JSON.parse(outputs[2]), {});
		assert.equal(store.getSession(sessionId)?.status, "dormant");
		assert.equal(
			store.getReminderBatchRecord(delayedBatchId, sessionId)?.state,
			"built",
		);
	} finally {
		store.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

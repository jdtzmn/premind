import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	codexHookInputSchema,
	interruptInputSchema,
	sessionEndInputSchema,
	sessionStartInputSchema,
	sessionStartOutputSchema,
	stopInputSchema,
	stopOutputSchema,
	userPromptSubmitInputSchema,
	userPromptSubmitOutputSchema,
} from "../schemas.ts";

const common = {
	session_id: "thread-1",
	transcript_path: null,
	cwd: "/repo",
	model: "gpt-test",
};

const interactive = {
	...common,
	permission_mode: "default" as const,
};

describe("Codex hook schemas", () => {
	test("accepts every pinned SessionStart source", () => {
		for (const source of ["startup", "resume", "clear", "compact"] as const) {
			assert.equal(
				sessionStartInputSchema.parse({
					...interactive,
					hook_event_name: "SessionStart",
					source,
				}).source,
				source,
			);
		}
	});

	test("accepts the pinned turn and cleanup event shapes", () => {
		const inputs = [
			userPromptSubmitInputSchema.parse({
				...interactive,
				hook_event_name: "UserPromptSubmit",
				turn_id: "turn-1",
				prompt: "sensitive prompt",
			}),
			stopInputSchema.parse({
				...interactive,
				hook_event_name: "Stop",
				turn_id: "turn-1",
				stop_hook_active: false,
				last_assistant_message: null,
			}),
			interruptInputSchema.parse({
				...interactive,
				hook_event_name: "Interrupt",
				turn_id: "turn-1",
			}),
			sessionEndInputSchema.parse({
				...common,
				hook_event_name: "SessionEnd",
				reason: "other",
			}),
		];
		for (const input of inputs)
			assert.deepEqual(codexHookInputSchema.parse(input), input);
	});

	test("rejects unknown, missing, and cross-event fields", () => {
		assert.equal(
			sessionStartInputSchema.safeParse({
				...interactive,
				hook_event_name: "SessionStart",
				source: "startup",
				unknown: true,
			}).success,
			false,
		);
		assert.equal(
			userPromptSubmitInputSchema.safeParse({
				...interactive,
				hook_event_name: "UserPromptSubmit",
				prompt: "missing turn id",
			}).success,
			false,
		);
		assert.equal(
			stopInputSchema.safeParse({
				...interactive,
				hook_event_name: "UserPromptSubmit",
				turn_id: "turn-1",
				stop_hook_active: false,
				last_assistant_message: null,
			}).success,
			false,
		);
	});

	test("validates protocol output shapes strictly", () => {
		assert.deepEqual(
			sessionStartOutputSchema.parse({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "context",
				},
			}).hookSpecificOutput.hookEventName,
			"SessionStart",
		);
		assert.equal(
			userPromptSubmitOutputSchema.safeParse({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: "context",
				},
			}).success,
			false,
		);
		assert.deepEqual(
			stopOutputSchema.parse({ decision: "block", reason: "continue" }),
			{
				decision: "block",
				reason: "continue",
			},
		);
		assert.equal(
			stopOutputSchema.safeParse({
				decision: "block",
				reason: "continue",
				extra: true,
			}).success,
			false,
		);
	});
});

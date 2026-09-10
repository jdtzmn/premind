import { z } from "zod";

const permissionModeSchema = z.enum([
	"default",
	"acceptEdits",
	"plan",
	"dontAsk",
	"bypassPermissions",
]);

const commonShape = {
	session_id: z.string().min(1),
	transcript_path: z.string().nullable(),
	cwd: z.string().min(1),
	model: z.string().min(1),
};

const interactiveShape = {
	...commonShape,
	permission_mode: permissionModeSchema,
};

export const sessionStartInputSchema = z
	.object({
		...interactiveShape,
		hook_event_name: z.literal("SessionStart"),
		source: z.enum(["startup", "resume", "clear", "compact"]),
	})
	.strict();

export const userPromptSubmitInputSchema = z
	.object({
		...interactiveShape,
		hook_event_name: z.literal("UserPromptSubmit"),
		turn_id: z.string().min(1),
		prompt: z.string(),
	})
	.strict();

export const stopInputSchema = z
	.object({
		...interactiveShape,
		hook_event_name: z.literal("Stop"),
		turn_id: z.string().min(1),
		stop_hook_active: z.boolean(),
		last_assistant_message: z.string().nullable(),
	})
	.strict();

export const interruptInputSchema = z
	.object({
		...interactiveShape,
		hook_event_name: z.literal("Interrupt"),
		turn_id: z.string().min(1),
	})
	.strict();

export const sessionEndInputSchema = z
	.object({
		...commonShape,
		hook_event_name: z.literal("SessionEnd"),
		reason: z.literal("other"),
	})
	.strict();

export const codexHookInputSchema = z.discriminatedUnion("hook_event_name", [
	sessionStartInputSchema,
	userPromptSubmitInputSchema,
	stopInputSchema,
	interruptInputSchema,
	sessionEndInputSchema,
]);

export const noOpOutputSchema = z.object({}).strict();

export const sessionStartOutputSchema = z
	.object({
		hookSpecificOutput: z
			.object({
				hookEventName: z.literal("SessionStart"),
				additionalContext: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export const userPromptSubmitOutputSchema = z
	.object({
		hookSpecificOutput: z
			.object({
				hookEventName: z.literal("UserPromptSubmit"),
				additionalContext: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export const stopOutputSchema = z
	.object({
		decision: z.literal("block"),
		reason: z.string().min(1),
	})
	.strict();

export const codexDeliveryReceiptSchema = z
	.object({
		sessionId: z.string().startsWith("codex:"),
		batchId: z.string().min(1),
		handoffId: z.string().uuid(),
		boundary: z.enum(["session_start", "user_prompt_submit", "stop"]),
		sourceTurnId: z.string().min(1).optional(),
		outputFlushedAt: z.number().int().nonnegative(),
		leaseExpiresAt: z.number().int().positive(),
	})
	.strict();

export type CodexHookInput = z.infer<typeof codexHookInputSchema>;
export type SessionStartInput = z.infer<typeof sessionStartInputSchema>;
export type UserPromptSubmitInput = z.infer<typeof userPromptSubmitInputSchema>;
export type StopInput = z.infer<typeof stopInputSchema>;
export type InterruptInput = z.infer<typeof interruptInputSchema>;
export type SessionEndInput = z.infer<typeof sessionEndInputSchema>;
export type CodexDeliveryReceipt = z.infer<typeof codexDeliveryReceiptSchema>;
export type CodexHookEventName = CodexHookInput["hook_event_name"];

import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { commandCapabilities } from "../shared/command-capabilities.ts"
import { GLOBAL_CONFIRMATION_DESCRIPTION, globalControlRefusal } from "../shared/global-control.ts"
import { subscribePayloadSchema, unsubscribePayloadSchema } from "../shared/schema.ts"
import type { premindActions } from "./actions.ts"

// OpenCode needs JSON Schema for the model; zod v3 cannot provide it, so each
// tool declares its JSON Schema and zod validates the same shape at runtime.
type ToolInput<T extends z.ZodType = z.ZodType> = { json: Record<string, unknown>; parse: T }
const object = (properties: Record<string, unknown>, required: string[] = []) =>
	({ type: "object", properties, required, additionalProperties: false })

const prNumberDescription = "Pull request number"
const repoDescription = "Optional owner/repository; defaults to the active worktree repository"
const writePolicyDescription =
	"Omit to verify ownership automatically. Use user-authorized only when the user explicitly authorizes work on this PR, or observe-only to prevent automatic escalation."

const empty: ToolInput = { json: object({}), parse: z.object({}).strict() }
const checkout = {
	json: object({ path: { type: "string", minLength: 1, description: "Absolute or project-relative path to the Git checkout" } }, ["path"]),
	parse: z.object({ path: z.string().min(1) }).strict(),
}
const subscriptionProperties = {
	prNumber: { type: "integer", exclusiveMinimum: 0, description: prNumberDescription },
	repo: { type: "string", minLength: 1, description: repoDescription },
}
const subscription = {
	json: object(subscriptionProperties, ["prNumber"]),
	parse: unsubscribePayloadSchema.omit({ sessionId: true }),
}
const subscribe = {
	json: object({
		...subscriptionProperties,
		writePolicy: { type: "string", enum: ["user-authorized", "observe-only"], description: writePolicyDescription },
	}, ["prNumber"]),
	parse: subscribePayloadSchema.omit({ sessionId: true }),
}
const confirmation = {
	json: object({ confirmGlobal: { type: "boolean", description: GLOBAL_CONFIRMATION_DESCRIPTION } }, ["confirmGlobal"]),
	// A missing confirmation gets the refusal that tells the model to ask, not a validation error.
	parse: z.object({ confirmGlobal: z.boolean().optional() }).strict(),
}

export function registerTools(ctx: Plugin.Context, actions: ReturnType<typeof premindActions>) {
	return ctx.tool.transform((editor) => {
		const add = <T extends z.ZodType>(name: string, description: string, input: ToolInput<T>, run: (input: z.output<T>, sessionID: string) => Promise<string>) => {
			editor.add({
				name, description, input: input.json, options: { namespace: "premind", codemode: false },
				execute: async (args, { sessionID }) => ({ content: await run(input.parse.parse(args), sessionID) }),
			})
		}
		add("status", commandCapabilities.status.toolGuidance, empty, (_, sessionID) => actions.status(sessionID))
		add("debug_status", commandCapabilities["debug-status"].toolGuidance, empty, (_, sessionID) => actions.debugStatus(sessionID))
		add("set_active_checkout", commandCapabilities["set-active-checkout"].toolGuidance, checkout, ({ path }, sessionID) => actions.setActiveCheckout(sessionID, path))
		add("subscribe", commandCapabilities.subscribe.toolGuidance, subscribe, (args, sessionID) => actions.subscribe(sessionID, args))
		add("unsubscribe", commandCapabilities.unsubscribe.toolGuidance, subscription, (args, sessionID) => actions.unsubscribe(sessionID, args))
		for (const name of ["deliver", "send_now"]) {
			add(name, commandCapabilities.deliver.toolGuidance, empty, (_, sessionID) => actions.deliver(sessionID))
		}
		for (const name of ["pause", "resume"] as const) {
			add(name, commandCapabilities[name].toolGuidance, empty, (_, sessionID) => actions.setPaused(sessionID, name === "pause"))
		}
		for (const name of ["disable", "enable"] as const) {
			add(name, commandCapabilities[name].toolGuidance, confirmation, async ({ confirmGlobal }) =>
				confirmGlobal ? actions.setDisabled(name === "disable") : globalControlRefusal(name))
		}
		for (const name of ["doctor", "probe"]) {
			add(name, commandCapabilities.doctor.toolGuidance, empty, () => actions.doctor())
		}
	})
}

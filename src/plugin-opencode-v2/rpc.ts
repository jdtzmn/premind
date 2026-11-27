import { Rpc } from "@opencode/plugin/rpc"
import type { CurrentStatusLine } from "../shared/status-view.ts"

/** RPC contract shared by the server and TUI parts of the OpenCode V2 plugin. */
export const PremindRpc = Rpc.define({
	id: "premind",
	methods: {
		ping: {
			input: { type: "object", properties: {}, additionalProperties: false },
			output: {
				type: "object",
				properties: { version: { type: "string" } },
				required: ["version"],
				additionalProperties: false,
			},
		},
		/** Runs a `premind:*` command (or alias) and returns its text. */
		command: {
			input: {
				type: "object",
				properties: {
					name: { type: "string" },
					sessionID: { type: "string" },
					args: { type: "string" },
				},
				required: ["name"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: { ok: { type: "boolean" }, text: { type: "string" } },
				required: ["ok", "text"],
				additionalProperties: false,
			},
		},
		/** Status lines with PR signals, so the TUI can color them. */
		statusLines: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: { lines: { type: "array", items: {} } },
				required: ["lines"],
				additionalProperties: false,
			},
		},
	},
	events: {},
})

export type PingOutput = { version: string }
export type CommandInput = { name: string; sessionID?: string; args?: string }
export type CommandOutput = { ok: boolean; text: string }
export type StatusLinesOutput = { lines: CurrentStatusLine[] }

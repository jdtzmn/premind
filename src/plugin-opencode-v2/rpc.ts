import { Rpc } from "@opencode/plugin/rpc"

/**
 * RPC contract shared by the server and TUI parts of the OpenCode V2 plugin.
 * The skeleton only answers `ping`; later changes add the command methods and
 * the status event.
 */
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
	},
	events: {},
})

export type PingOutput = { version: string }

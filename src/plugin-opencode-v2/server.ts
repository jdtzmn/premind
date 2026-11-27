import { Plugin } from "@opencode/plugin"
import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import { premindActions } from "./actions.ts"
import { registerCommands, runPremindCommand } from "./commands.ts"
import { PremindRpc, type CommandInput, type CommandOutput, type PingOutput, type StatusLinesOutput } from "./rpc.ts"
import { type SessionTrackingOptions, trackSessions } from "./sessions.ts"
import { registerSkill } from "./skill.ts"
import { registerTools } from "./tools.ts"

/** Wires every server surface onto one OpenCode location. */
export async function createPremindServer(ctx: Plugin.Context, options: SessionTrackingOptions = {}) {
	const sessions = trackSessions(ctx, options)
	const actions = premindActions(sessions, ctx.location.directory)
	let rpc: { dispose(): Promise<void> | void } | undefined
	try {
		rpc = await ctx.rpc.register(PremindRpc, {
			ping: async (): Promise<PingOutput> => ({ version: PREMIND_VERSION_LABEL }),
			command: async (input): Promise<CommandOutput> => {
				const { name, sessionID, args } = input as CommandInput
				return runPremindCommand(actions, name, sessionID, args)
			},
			statusLines: async (input): Promise<StatusLinesOutput> =>
				({ lines: await actions.statusLines((input as { sessionID: string }).sessionID) }),
		})
		await registerTools(ctx, actions)
		await registerCommands(ctx, actions)
		await registerSkill(ctx)
	} catch (error) {
		await rpc?.dispose()
		await sessions.dispose()
		throw error
	}
	return {
		sessions,
		async dispose() {
			await sessions.dispose()
			await rpc?.dispose()
		},
	}
}

export default Plugin.define({
	id: "premind",
	async setup(ctx) {
		return (await createPremindServer(ctx)).dispose
	},
})

import { Plugin } from "@opencode/plugin"
import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import { premindActions } from "./actions.ts"
import { PremindRpc, type PingOutput } from "./rpc.ts"
import { trackSessions } from "./sessions.ts"
import { registerSkill } from "./skill.ts"
import { registerTools } from "./tools.ts"

export default Plugin.define({
	id: "premind",
	async setup(ctx) {
		const rpc = await ctx.rpc.register(PremindRpc, {
			ping: async (): Promise<PingOutput> => ({ version: PREMIND_VERSION_LABEL }),
		})
		const sessions = trackSessions(ctx)
		try {
			await registerTools(ctx, premindActions(sessions, ctx.location.directory))
			await registerSkill(ctx)
		} catch (error) {
			await sessions.dispose()
			throw error
		}
		return async () => {
			await sessions.dispose()
			await rpc.dispose()
		}
	},
})

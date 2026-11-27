import { Plugin } from "@opencode/plugin"
import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import { PremindRpc, type PingOutput } from "./rpc.ts"
import { trackSessions } from "./sessions.ts"

export default Plugin.define({
	id: "premind",
	async setup(ctx) {
		const rpc = await ctx.rpc.register(PremindRpc, {
			ping: async (): Promise<PingOutput> => ({ version: PREMIND_VERSION_LABEL }),
		})
		const sessions = trackSessions(ctx)
		return async () => {
			await sessions.dispose()
			await rpc.dispose()
		}
	},
})

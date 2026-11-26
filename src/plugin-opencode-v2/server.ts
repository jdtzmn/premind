import { Plugin } from "@opencode/plugin"
import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import { PremindRpc, type PingOutput } from "./rpc.ts"

/**
 * Server part of the OpenCode V2 plugin. This skeleton proves the plugin loads
 * and answers RPC; session tracking, delivery, tools and commands come next.
 */
export default Plugin.define({
	id: "premind",
	async setup(ctx) {
		const rpc = await ctx.rpc.register(PremindRpc, {
			ping: async (): Promise<PingOutput> => ({ version: PREMIND_VERSION_LABEL }),
		})
		return async () => {
			await rpc.dispose()
		}
	},
})

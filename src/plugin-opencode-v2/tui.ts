import { Plugin } from "@opencode/plugin/tui"
import { premindCommands, type PremindCommand } from "./commands.ts"
import { PremindRpc, type CommandOutput } from "./rpc.ts"

/** Results long enough to read in a dialog instead of a toast. */
const REPORTS = new Set(["premind:status", "premind:debug-status", "premind:doctor"])
/** Commands that change every session and project, so they ask first. */
const GLOBAL = new Set(["premind:enable", "premind:disable"])

/**
 * TUI half of the plugin: slash and palette commands that run on the server
 * over RPC and show the result in a dialog or toast, without a model turn.
 */
export default Plugin.define({
	id: "premind",
	setup(ctx) {
		const sessionID = () => {
			const route = ctx.ui.router.current()
			return route.type === "session" ? route.sessionID : undefined
		}

		/** The server part loads on the location's first request, so retry once. */
		const call = async (name: string, args: string): Promise<CommandOutput> => {
			const input = { name, sessionID: sessionID(), args }
			const rpc = ctx.client.rpc(PremindRpc)
			try {
				return await rpc.command(input) as CommandOutput
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250))
				return await rpc.command(input) as CommandOutput
			}
		}

		const run = async (command: PremindCommand, input?: string) => {
			let args = input?.trim() ?? ""
			if (command.arguments && !args) {
				const answer = await ctx.ui.dialog.prompt({ title: command.name, description: command.description })
				if (answer === undefined) return
				args = answer
			}
			if (GLOBAL.has(command.name)) {
				const confirmed = await ctx.ui.dialog.confirm({
					title: command.name,
					message: `${command.description}?`,
				})
				if (!confirmed) return
			}
			let result: CommandOutput
			try {
				result = await call(command.name, args)
			} catch (error) {
				result = { ok: false, text: `${command.name} failed: ${error instanceof Error ? error.message : String(error)}` }
			}
			if (result.ok && REPORTS.has(command.name)) {
				await ctx.ui.dialog.alert({ title: command.name, message: result.text })
				return
			}
			ctx.ui.toast.show({
				title: "premind",
				message: result.text,
				variant: result.ok ? "success" : "error",
				sessionID: sessionID(),
			})
		}

		ctx.keymap.layer(() => ({
			commands: premindCommands.map((command) => ({
				id: command.name,
				title: command.name,
				description: command.description,
				group: "Premind",
				palette: true as const,
				slash: {
					name: command.name,
					...(command.aliases ? { aliases: [...command.aliases] } : {}),
					...(command.arguments ? { arguments: true as const } : {}),
				},
				run: (input?: string) => run(command, input),
			})),
		}))
	},
})

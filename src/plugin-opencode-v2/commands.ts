import type { Plugin } from "@opencode/plugin"
import type { premindActions } from "./actions.ts"

type Actions = ReturnType<typeof premindActions>

export type PremindCommand = {
	readonly name: string
	readonly description: string
	/** Old V1 names kept so muscle memory keeps working. */
	readonly aliases?: readonly string[]
	/** Whether the command accepts free-form arguments after its name. */
	readonly arguments?: boolean
	/** Commands that act on one session need it; global ones ignore it. */
	readonly run: (actions: Actions, sessionID: string | undefined, args: string) => Promise<string>
}

const requireSession = (sessionID: string | undefined) => {
	if (!sessionID) throw new Error("open a session first")
	return sessionID
}

const parsePullRequest = (args: string, usage: string) => {
	const [number, repo, ...rest] = args.trim().split(/\s+/).filter(Boolean)
	const prNumber = Number(number?.replace(/^#/, ""))
	if (!Number.isInteger(prNumber) || prNumber <= 0 || rest.length > 0) throw new Error(`usage: ${usage}`)
	return repo ? { prNumber, repo } : { prNumber }
}

/**
 * Commands a user runs directly, with no model turn. The TUI runs them over
 * RPC; clients without the TUI run them through `ctx.command.transform`.
 */
export const premindCommands: readonly PremindCommand[] = [
	{
		name: "premind:status",
		aliases: ["premind-status"],
		description: "Show premind status for this session",
		run: (actions, sessionID) => actions.status(requireSession(sessionID)),
	},
	{
		name: "premind:debug-status",
		description: "Show detailed premind daemon state",
		run: (actions, sessionID) => actions.debugStatus(sessionID ?? ""),
	},
	{
		name: "premind:doctor",
		description: "Check that the premind plugin and daemon are healthy",
		run: (actions) => actions.doctor(),
	},
	{
		name: "premind:subscribe",
		arguments: true,
		description: "Watch a pull request: /premind:subscribe <pr> [owner/repo]",
		run: (actions, sessionID, args) =>
			actions.subscribe(requireSession(sessionID), parsePullRequest(args, "/premind:subscribe <pr> [owner/repo]")),
	},
	{
		name: "premind:unsubscribe",
		arguments: true,
		description: "Stop watching a pull request: /premind:unsubscribe <pr> [owner/repo]",
		run: (actions, sessionID, args) =>
			actions.unsubscribe(requireSession(sessionID), parsePullRequest(args, "/premind:unsubscribe <pr> [owner/repo]")),
	},
	{
		name: "premind:set-active-checkout",
		arguments: true,
		description: "Set the Git checkout this session works in: /premind:set-active-checkout <path>",
		run: (actions, sessionID, args) => {
			const path = args.trim()
			if (!path) throw new Error("usage: /premind:set-active-checkout <path>")
			return actions.setActiveCheckout(requireSession(sessionID), path)
		},
	},
	{
		name: "premind:pause",
		description: "Pause premind reminders for this session",
		run: (actions, sessionID) => actions.setPaused(requireSession(sessionID), true),
	},
	{
		name: "premind:resume",
		description: "Resume premind reminders for this session",
		run: (actions, sessionID) => actions.setPaused(requireSession(sessionID), false),
	},
	{
		name: "premind:deliver",
		aliases: ["premind-send-now"],
		description: "Deliver pending PR updates to this session now",
		run: (actions, sessionID) => actions.deliver(requireSession(sessionID)),
	},
	{
		name: "premind:enable",
		aliases: ["premind-enable"],
		description: "Re-enable premind GitHub polling globally, across all sessions and projects",
		run: (actions) => actions.setDisabled(false),
	},
	{
		name: "premind:disable",
		aliases: ["premind-disable"],
		description: "Disable premind GitHub polling globally (use /premind:pause for this session only)",
		run: (actions) => actions.setDisabled(true),
	},
	{
		name: "premind:prune",
		description: "Remove closed premind sessions and their pending reminders from daemon state",
		run: (actions) => actions.prune(),
	},
]

const byName = new Map(premindCommands.flatMap((command) =>
	[command.name, ...(command.aliases ?? [])].map((name) => [name, command] as const)))

export type CommandResult = { readonly ok: boolean; readonly text: string }

/** Runs a command by name or alias and reports failures as text instead of throwing. */
export async function runPremindCommand(
	actions: Actions,
	name: string,
	sessionID: string | undefined,
	args = "",
): Promise<CommandResult> {
	const command = byName.get(name)
	if (!command) return { ok: false, text: `premind: unknown command ${name}` }
	try {
		return { ok: true, text: await command.run(actions, sessionID, args) }
	} catch (error) {
		return { ok: false, text: `${command.name} failed: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/**
 * Registers the commands for clients without the TUI (Desktop, web,
 * `opencode run`). OpenCode shows nothing unless the handler sends a message,
 * so the result is queued into the session without starting a turn.
 */
export function registerCommands(ctx: Plugin.Context, actions: Actions) {
	return ctx.command.transform((editor) => {
		for (const command of premindCommands) {
			for (const name of [command.name, ...(command.aliases ?? [])]) {
				editor.add({
					name,
					description: command.description,
					execute: async ({ sessionID, prompt }) => {
						const result = await runPremindCommand(actions, name, sessionID, prompt.text ?? "")
						await ctx.session.synthetic({
							sessionID,
							id: `msg_premind_command_${crypto.randomUUID()}`,
							text: result.text,
							description: `/${command.name}`,
							delivery: "queue",
							resume: false,
						})
					},
				})
			}
		}
	})
}

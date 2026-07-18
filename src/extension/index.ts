import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderPremindStatus } from "../plugin/commands.ts";
import { PremindDaemonClient } from "../plugin/daemon-client.ts";
import type { DebugStatusResponse } from "../shared/schema.ts";

type DaemonClientLike = {
	debugStatus: () => Promise<DebugStatusResponse>;
};

export type PremindPiExtensionDependencies = {
	createDaemonClient?: () => DaemonClientLike;
};

const STATUS_ERROR_PREFIX = "premind status failed";

export const createPremindPiExtension = (
	dependencies: PremindPiExtensionDependencies = {},
) => {
	return function premindPiExtension(pi: ExtensionAPI): void {
		const createDaemonClient =
			dependencies.createDaemonClient ?? (() => new PremindDaemonClient());

		const getStatusText = async () => {
			const status = await createDaemonClient().debugStatus();
			return renderPremindStatus(status);
		};

		pi.registerCommand("premind:status", {
			description:
				"Show premind daemon status, attached sessions, and pending reminders",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(await getStatusText(), "info");
				} catch (error) {
					ctx.ui.notify(
						`${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerTool({
			name: "premind_status",
			label: "Premind Status",
			description:
				"Show premind daemon status including active sessions, watchers, and pending reminder counts.",
			promptSnippet: "Inspect premind PR reminder daemon status.",
			promptGuidelines: [
				"Use premind_status when the user asks about premind daemon state, PR reminder attachment, pending reminders, or watcher status.",
			],
			parameters: Type.Object({}),
			async execute() {
				try {
					return {
						content: [{ type: "text" as const, text: await getStatusText() }],
						details: {},
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: {},
					};
				}
			},
		});
	};
};

export default createPremindPiExtension();

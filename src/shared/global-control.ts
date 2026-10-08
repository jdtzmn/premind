/**
 * Shared wording for the daemon-wide enable/disable model tools. They affect
 * every session and project, so each harness refuses to act unless the call
 * passes `confirmGlobal: true`. Tool descriptions come from each capability's
 * `toolGuidance` in `command-capabilities.ts`. The Claude MCP server is plain
 * JavaScript and mirrors these strings; its tests compare them.
 */
export type GlobalControlAction = "enable" | "disable";

export const GLOBAL_CONFIRMATION_DESCRIPTION =
	"Must be true. Set it only after the user explicitly asked to change premind polling globally for every session and project.";

export const globalControlRefusal = (action: GlobalControlAction): string =>
	`premind refused to ${action} polling globally: this affects every session and project. Ask the user to confirm the global ${action}, then call again with confirmGlobal: true. To change only this session, use the session ${action === "disable" ? "pause" : "resume"} tool.`;

export const globalControlResult = (disabled: boolean): string =>
	`premind polling is ${disabled ? "disabled" : "enabled"} globally, across all sessions and projects.`;

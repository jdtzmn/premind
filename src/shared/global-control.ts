/**
 * Shared wording and confirmation rules for the daemon-wide enable/disable
 * controls. These affect every session and project, so model-callable tools
 * must refuse to act without an explicit `confirmGlobal: true` argument.
 */
export type GlobalControlAction = "enable" | "disable";

export const GLOBAL_CONFIRMATION_DESCRIPTION =
	"Must be true. Set it only after the user explicitly asked to change premind polling globally for every session and project.";

export const globalControlToolDescription = (
	action: GlobalControlAction,
	sessionAlternative?: string,
): string => {
	const effect =
		action === "disable"
			? "Disable premind GitHub polling globally, stopping it for ALL sessions and projects."
			: "Enable premind GitHub polling globally, resuming it for ALL sessions and projects.";
	const scope =
		action === "disable"
			? "Never use this to pause, mute, or quiet the current session"
			: "Never use this to resume one session";
	return [
		effect,
		`Call only when the user explicitly requested the global ${action} action, and pass confirmGlobal: true.`,
		sessionAlternative ? `${scope}; use ${sessionAlternative} instead.` : `${scope}.`,
	].join(" ");
};

export const globalControlRefusal = (
	action: GlobalControlAction,
	sessionAlternative?: string,
): string =>
	[
		`premind refused to ${action} polling globally: this affects every session and project.`,
		`Ask the user to confirm the global ${action}, then call again with confirmGlobal: true.`,
		...(sessionAlternative
			? [`To change only the current session, use ${sessionAlternative}.`]
			: []),
	].join(" ");

export const globalControlResult = (disabled: boolean): string =>
	`premind polling is ${disabled ? "disabled" : "enabled"} globally, across all sessions and projects.`;

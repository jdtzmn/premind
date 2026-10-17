/**
 * Shared result text for the per-session pause and resume controls. Pause only
 * withholds reminder delivery for one session; it never changes subscriptions.
 * The Claude MCP server is plain JavaScript and mirrors these strings; its
 * tests compare them.
 */
export const SESSION_PAUSED_MESSAGE =
	"premind paused reminders for this session only. Subscriptions are unchanged and PR updates keep accumulating until you resume.";

export const SESSION_RESUMED_MESSAGE =
	"premind resumed reminders for this session. Subscriptions are unchanged; queued PR updates arrive at the next safe point.";

export const SESSION_PAUSED_DELIVERY_MESSAGE =
	"premind is paused for this session; resume it before delivering reminders.";

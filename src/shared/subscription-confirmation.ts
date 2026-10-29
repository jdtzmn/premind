import type { SubscriptionWritePolicy } from "./schema.ts";

/** Describe the daemon's current result, not a lasting grant of authority. */
export function formatSubscriptionConfirmation(
	target: string,
	writePolicy: SubscriptionWritePolicy | undefined,
): string {
	const prefix = `Subscribed to ${target} for CI and review updates.`;
	switch (writePolicy) {
		case "observe-only":
			return `${prefix} Current Premind policy: observe-only. Notifications alone do not authorize edits or replies; follow the user-assigned task and repository policy.`;
		case "owned-active":
			return `${prefix} Current Premind policy: owned-active. Premind verified ownership and the active checkout; follow the assigned task and repository policy.`;
		case "user-authorized":
			return `${prefix} Current Premind policy: user-authorized. Follow-up is limited to the user-assigned scope and repository policy.`;
		default:
			return `${prefix} Premind did not report a write policy. Do not infer ownership or write permission from this confirmation.`;
	}
}

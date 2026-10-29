import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionWritePolicy } from "./schema.ts";
import { formatSubscriptionConfirmation } from "./subscription-confirmation.ts";
// @ts-expect-error The shipped Claude MCP runtime is plain JavaScript.
import { formatSubscriptionConfirmation as formatClaudeConfirmation } from "../../plugin-claude/bin/mcp-server.mjs";

const prefix = "Subscribed to owner/repo#42 for CI and review updates.";
const cases: Array<[SubscriptionWritePolicy | undefined, string]> = [
	["observe-only", "Current Premind policy: observe-only. Notifications alone do not authorize edits or replies; follow the user-assigned task and repository policy."],
	["owned-active", "Current Premind policy: owned-active. Premind verified ownership and the active checkout; follow the assigned task and repository policy."],
	["user-authorized", "Current Premind policy: user-authorized. Follow-up is limited to the user-assigned scope and repository policy."],
	[undefined, "Premind did not report a write policy. Do not infer ownership or write permission from this confirmation."],
];

for (const [writePolicy, explanation] of cases) {
	test(`subscription confirmation describes current ${writePolicy ?? "unreported"} policy with Claude parity`, () => {
		const expected = `${prefix} ${explanation}`;
		assert.equal(formatSubscriptionConfirmation("owner/repo#42", writePolicy), expected);
		assert.equal(formatClaudeConfirmation("owner/repo#42", writePolicy), expected);
		assert.doesNotMatch(expected, /will (?:be|become)|automatically|permanent/i);
	});
}

import assert from "node:assert/strict";
import {
	type CapabilityException,
	hostLimitations,
	type PremindHarness,
	premindHarnessLabels,
} from "./command-capabilities.ts";

/**
 * Rejects an `unsupported` exception unless it names an approved entry in
 * `hostLimitations` that matches this harness, surface, and capability. An
 * invented reason such as "this feature is Pi-specific" fails here (#85).
 */
export const assertApprovedUnsupported = (
	exception: CapabilityException | undefined,
	context: {
		label: string;
		harness: PremindHarness;
		surface: string;
		capabilityId?: string;
	},
) => {
	if (exception?.kind !== "unsupported") return;
	const rejection = [
		`${context.label} claims ${premindHarnessLabels[context.harness]} cannot support this,`,
		"but that is not an approved host limitation.",
		`Implement it in ${premindHarnessLabels[context.harness]} instead.`,
		"Only the user can approve a new entry in hostLimitations (src/shared/command-capabilities.ts).",
	].join(" ");
	const limitation = (hostLimitations as Record<string, (typeof hostLimitations)[keyof typeof hostLimitations]>)[
		exception.limitation
	];
	assert.ok(limitation, rejection);
	assert.equal(limitation.harness, context.harness, rejection);
	assert.equal(limitation.surface, context.surface, rejection);
	if ("capabilities" in limitation && context.capabilityId) {
		assert.ok(
			(limitation.capabilities as readonly string[]).includes(context.capabilityId),
			rejection,
		);
	}
	assert.equal(
		exception.reason,
		limitation.reason,
		`${context.label} must use unsupported("${exception.limitation}") rather than restating its reason`,
	);
};

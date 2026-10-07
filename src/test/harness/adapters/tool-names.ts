/** Resolves a harness's real model tool for a capability through the registry. */

import {
	type CommandCapability,
	type CommandCapabilityId,
	commandCapabilities,
	harnessSurface,
	type PremindHarness,
} from "../../../shared/command-capabilities.ts"

export const harnessToolName = (
	harness: PremindHarness,
	capabilityId: CommandCapabilityId,
): string => {
	const capability = commandCapabilities[capabilityId] as CommandCapability
	const [name] = harnessSurface(capability, harness).tools
	if (!name) {
		throw new Error(
			`${harness} has no ${capabilityId} tool; the scenario should be excused by its capability exception`,
		)
	}
	return name
}

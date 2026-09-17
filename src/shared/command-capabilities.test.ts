import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	commandCapabilities,
	expectedCapabilitySurface,
	premindHarnesses,
} from "./command-capabilities.ts";

describe("command capability contract", () => {
	test("common capabilities explain every omitted surface", () => {
		for (const [capabilityId, capability] of Object.entries(
			commandCapabilities,
		)) {
			if (capability.classification !== "common") continue;
			for (const harness of premindHarnesses) {
				const surface = capability.harnesses[harness];
				for (const kind of ["commands", "tools"] as const) {
					if (surface[kind].length > 0) continue;
					const exceptions =
						"exceptions" in surface
							? (surface.exceptions as Partial<Record<typeof kind, string>>)
							: undefined;
					assert.ok(
						exceptions?.[kind],
						`${capabilityId}.${harness}.${kind} requires an explicit exception`,
					);
				}
			}
		}
	});

	test("surface names are unique within each harness", () => {
		for (const harness of premindHarnesses) {
			for (const kind of ["commands", "tools"] as const) {
				const names = expectedCapabilitySurface(harness, kind);
				assert.equal(
					new Set(names).size,
					names.length,
					`${harness} declares a duplicate ${kind} name`,
				);
			}
		}
	});
});

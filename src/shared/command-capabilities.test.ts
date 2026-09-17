import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
	commandCapabilities,
	expectedCapabilitySurface,
	renderCommandCapabilityDocumentation,
	premindHarnesses,
} from "./command-capabilities.ts";

describe("command capability contract", () => {
	test("common capabilities explain omitted or noncanonical surfaces", () => {
		for (const [capabilityId, capability] of Object.entries(
			commandCapabilities,
		)) {
			if (capability.classification !== "common") continue;
			for (const harness of premindHarnesses) {
				const surface = capability.harnesses[harness];
				for (const kind of ["commands", "tools"] as const) {
					const canonicalNames: readonly string[] = capability.canonical[kind];
					const surfaceNames: readonly string[] = surface[kind];
					const differsFromCanonical =
						canonicalNames.some((name) => !surfaceNames.includes(name)) ||
						surfaceNames.some((name) => !canonicalNames.includes(name));
					if (!differsFromCanonical) continue;
					const exceptions =
						"exceptions" in surface
							? (surface.exceptions as Partial<Record<typeof kind, string>>)
							: undefined;
					assert.ok(
						exceptions?.[kind],
						`${capabilityId}.${harness}.${kind} differs from the canonical surface and requires an explicit exception`,
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

	test("generated capability documentation is current", () => {
		const documentation = readFileSync(
			new URL("../../docs/command-capabilities.md", import.meta.url),
			"utf8",
		);
		assert.equal(documentation, renderCommandCapabilityDocumentation());
	});
});

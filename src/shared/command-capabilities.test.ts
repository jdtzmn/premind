import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
	type CommandCapability,
	commandCapabilities,
	expectedCapabilitySurface,
	harnessSurface,
	listCapabilityExceptions,
	premindHarnesses,
	renderCommandCapabilityDocumentation,
} from "./command-capabilities.ts";

const capabilities = Object.entries(
	commandCapabilities as Record<string, CommandCapability>,
);

describe("command capability contract", () => {
	test("every capability declares every supported harness", () => {
		for (const [capabilityId, capability] of capabilities) {
			assert.deepEqual(
				Object.keys(capability.harnesses).sort(),
				[...premindHarnesses].sort(),
				`${capabilityId} must declare a surface for every supported harness`,
			);
		}
	});

	test("every missing or renamed surface has a typed exception, whatever the classification", () => {
		for (const [capabilityId, capability] of capabilities) {
			for (const harness of premindHarnesses) {
				const surface = harnessSurface(capability, harness);
				for (const kind of ["commands", "tools"] as const) {
					const canonical = capability.canonical[kind];
					const actual = surface[kind];
					const differs =
						canonical.some((name) => !actual.includes(name)) ||
						actual.some((name) => !canonical.includes(name));
					const exception = surface.exceptions?.[kind];
					if (differs) {
						assert.ok(
							exception,
							`${capabilityId}.${harness}.${kind} differs from the canonical surface and requires an unsupported, deferred, or host-naming exception`,
						);
					} else {
						assert.equal(
							exception,
							undefined,
							`${capabilityId}.${harness}.${kind} matches the canonical surface; remove its stale exception`,
						);
					}
				}
			}
		}
	});

	test("exceptions are well-formed", () => {
		for (const { capabilityId, harness, surface, exception } of listCapabilityExceptions()) {
			const label = `${capabilityId}.${harness}.${surface}`;
			assert.ok(exception.reason.trim(), `${label} needs a reason`);
			if (exception.kind === "deferred") {
				assert.match(
					exception.tracking ?? "",
					/^(#\d+|https:\/\/github\.com\/\S+)$/,
					`${label} is deferred and must name a tracking issue or PR`,
				);
			}
			if (exception.kind === "host-naming") {
				const surfaceNames = harnessSurface(
					commandCapabilities[capabilityId as keyof typeof commandCapabilities],
					harness,
				)[surface];
				assert.ok(
					surfaceNames.length > 0,
					`${label} is host-naming but exposes no surface; use unsupported or deferred`,
				);
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

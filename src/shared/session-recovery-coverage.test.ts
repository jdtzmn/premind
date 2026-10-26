import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	premindHarnesses,
	sessionRecoveryCoverage,
} from "./command-capabilities.ts";

describe("missing-registration recovery lifecycle coverage", () => {
	test("declares exactly the canonical supported harnesses", () => {
		assert.deepEqual(
			Object.keys(sessionRecoveryCoverage).sort(),
			[...premindHarnesses].sort(),
		);
	});

	for (const harness of premindHarnesses) {
		test(`${harness} records implementation or an approved deferral`, () => {
			const coverage = sessionRecoveryCoverage[harness];
			assert.notEqual(coverage.kind, "unsupported");
			if (harness === "pi") {
				assert.equal(coverage.kind, "implemented");
			} else {
				assert.equal(coverage.kind, "deferred");
				assert.ok("tracking" in coverage);
				assert.equal(coverage.tracking, "#103");
				assert.ok(coverage.reason.trim());
			}
		});
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseAssets } from "./publish-dist.mjs";

const metadata = {
	packageVersion: "0.1.0",
	sourceCommit: "a".repeat(40),
	archives: {
		npm: { file: "premind-0.1.0.tgz" },
		codex: { file: "premind-codex-0.1.0.tgz" },
		claude: { file: "premind-claude-0.2.0.tgz" },
	},
};

test("promotes precisely the verified host archives, checksums and manifest", () => {
	assert.deepEqual(releaseAssets("/dist", metadata, "v0.1.0", "a".repeat(40)), [
		"/dist/premind-0.1.0.tgz",
		"/dist/premind-codex-0.1.0.tgz",
		"/dist/premind-claude-0.2.0.tgz",
		"/dist/SHA256SUMS",
		"/dist/artifact.json",
	]);
});

test("refuses version or source commit drift", () => {
	assert.throws(() => releaseAssets("/dist", metadata, "v0.2.0", "a".repeat(40)), /tag does not match/);
	assert.throws(() => releaseAssets("/dist", metadata, "v0.1.0", "b".repeat(40)), /tag commit does not match/);
});

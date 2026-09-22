import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isVersionAtLeast,
  parseCodexVersion,
} from "./codex-version.mjs";

const minimum = [0, 155, 1];

test("accepts the minimum Codex version and later releases", () => {
  for (const version of ["0.155.1", "0.156.0", "1.0.0"]) {
    assert.equal(
      isVersionAtLeast(parseCodexVersion(`codex-cli ${version}`), minimum),
      true,
    );
  }
});

test("rejects Codex versions below the minimum", () => {
  for (const version of ["0.155.0", "0.154.99"]) {
    assert.equal(
      isVersionAtLeast(parseCodexVersion(`codex-cli ${version}`), minimum),
      false,
    );
  }
});

test("rejects unrecognized Codex version output", () => {
  assert.throws(() => parseCodexVersion("codex 0.155.1"), /Cannot parse/);
});

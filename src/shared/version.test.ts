import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPremindVersion } from "./version.ts";

test("formats the premind version and six-character commit", () => {
  assert.equal(
    formatPremindVersion("1.2.3", "abcdef123456"),
    "v1.2.3 (abcdef)",
  );
});

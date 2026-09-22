import assert from "node:assert/strict";

export function parseCodexVersion(output) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(output);
  assert.ok(match, `Cannot parse Codex CLI version: ${output}`);
  return match.slice(1).map(Number);
}

export function isVersionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

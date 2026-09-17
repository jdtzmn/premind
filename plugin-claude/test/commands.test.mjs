import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const deliverCommand = new URL("../commands/deliver.md", import.meta.url);

test("deliver command ends the turn without creating a second delivery path", async () => {
  const source = await readFile(deliverCommand, "utf8");
  assert.match(source, /End this turn immediately/i);
  assert.match(source, /Stop hook/);
  assert.match(source, /without .*calling any tools/i);
  assert.doesNotMatch(source, /mcp__/i);
});

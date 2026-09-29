import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { parseStatusRow, statusColor } from "../tui.ts";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";

const colors = { error: "red", warning: "amber", success: "green", accent: "purple", textMuted: "muted" } as unknown as TuiThemeCurrent;

test("OpenCode TUI pairs each Unicode status word and clickable URL with its theme color", () => {
  const cases = [
    ["✗ CI failing, conflicts", "error", "red"], ["! changes requested", "warning", "amber"],
    ["○ draft", "muted", "muted"], ["… checks pending", "warning", "amber"],
    ["✓ ready to merge", "success", "green"], ["◆ merged", "merged", "purple"],
    ["? status unknown", "unknown", "muted"],
  ] as const;
  for (const [label, kind, color] of cases) {
    const parsed = parseStatusRow(`  #42 Important PR · ${label} — https://github.com/acme/repo/pull/42`);
    assert.deepEqual(parsed, { prefix: "  #42 Important PR · ", signal: label, url: "https://github.com/acme/repo/pull/42", kind });
    assert.equal(statusColor(colors, parsed!.kind), color);
  }
  assert.equal(parseStatusRow("Watching 0 PRs"), null);
  assert.equal(parseStatusRow("  #42 · ? status unknown — link unavailable")?.kind, "unknown");
});

test("OpenCode TUI companion registers the canonical colored status command", async () => {
  let names: string[] = [];
  await plugin.tui({ command: { register(factory: () => Array<{ slash?: { name: string } }>) { names = factory().map((command) => command.slash?.name ?? ""); return () => {}; } } } as never, undefined, {} as never);
  assert.deepEqual(names, ["premind:status"]);
});

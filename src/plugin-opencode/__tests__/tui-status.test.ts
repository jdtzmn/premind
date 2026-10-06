import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import plugin, { statusColor } from "../tui.ts";

const colors = {
  error: "red",
  warning: "amber",
  success: "green",
  accent: "purple",
  textMuted: "muted",
} as unknown as TuiThemeCurrent;

test("OpenCode TUI maps each status signal to its theme color", () => {
  const cases = [
    ["error", "red"],
    ["warning", "amber"],
    ["success", "green"],
    ["merged", "purple"],
    ["muted", "muted"],
    ["unknown", "muted"],
  ] as const;

  for (const [kind, color] of cases) {
    assert.equal(statusColor(colors, kind), color);
  }
});

test("OpenCode TUI companion registers the canonical colored status command", async () => {
  let names: string[] = [];
  await plugin.tui({
    command: {
      register(factory: () => Array<{ slash?: { name: string } }>) {
        names = factory().map((command) => command.slash?.name ?? "");
        return () => {};
      },
    },
  } as never, undefined, {} as never);
  assert.deepEqual(names, ["premind:status"]);
});

import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const output = "plugin-claude/runtime/premind-daemon.mjs";
mkdirSync("plugin-claude/runtime", { recursive: true });
rmSync(output, { force: true });

const result = spawnSync(
  process.env.BUN_BINARY ?? "bun",
  [
    "build",
    "src/daemon/index.ts",
    "--target=node",
    "--format=esm",
    `--outfile=${output}`,
    "--external",
    "node:sqlite",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

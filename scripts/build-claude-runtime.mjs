import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const builds = [
  {
    entrypoint: "src/daemon/index.ts",
    output: "plugin-claude/runtime/premind-daemon.mjs",
    external: ["node:sqlite"],
  },
  {
    entrypoint: "src/shared/daemon-startup.ts",
    output: "plugin-claude/runtime/daemon-startup.mjs",
    external: [],
  },
];

mkdirSync("plugin-claude/runtime", { recursive: true });

for (const { entrypoint, output, external } of builds) {
  rmSync(output, { force: true });
  const result = spawnSync(
    process.env.BUN_BINARY ?? "bun",
    [
      "build",
      entrypoint,
      "--target=node",
      "--format=esm",
      `--outfile=${output}`,
      ...external.flatMap((module) => ["--external", module]),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

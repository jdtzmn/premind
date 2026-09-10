import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assertSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
} from "../shared/node-version.ts";

export { assertSupportedNodeVersion, MINIMUM_NODE_VERSION };

export type NodeRuntime = {
  executable: string;
  version: string;
};

const findOnPath = (name: string, environmentPath = process.env.PATH ?? "") => {
  const names =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.cmd`, name]
      : [name];
  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const candidateName of names) {
      const candidate = path.join(directory, candidateName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

export const resolveNodeRuntime = (
  options: { executable?: string; environmentPath?: string } = {},
): NodeRuntime => {
  const executable =
    options.executable ?? findOnPath("node", options.environmentPath);
  if (!executable) {
    throw new Error(
      `Cannot start Premind: Node.js ${MINIMUM_NODE_VERSION} or newer is not available on PATH`,
    );
  }
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) {
    throw new Error(
      `Cannot run Node.js at ${executable}: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Cannot determine Node.js version at ${executable}: exit ${result.status ?? "unknown"}`,
    );
  }
  const version = result.stdout.trim();
  assertSupportedNodeVersion(version);
  return { executable, version };
};

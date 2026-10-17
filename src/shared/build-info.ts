import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PREMIND_BUILD_TIME } from "./version.generated.ts";

// Resolved like src/shared/version.ts: from a bundle under <plugin>/generated/
// this is the same package root as for the source tree, so every launcher and
// the daemon it starts report the same build.
const PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/**
 * The build a launcher would start, or a daemon is running. `version` is the
 * package version; `buildTime` is the commit time of the build in seconds,
 * because Premind installs from git checkouts whose version rarely changes.
 * `0.0.0` and a zero build time mean unknown.
 */
export type DaemonBuild = { version: string; buildTime: number };

// Replaced by scripts/build-runtime.mjs in installed bundles; undefined when
// running from source.
declare const PREMIND_BUNDLED_BUILD:
  | { version: string; commit: string; buildTime: number }
  | undefined;

/** The build identity stamped into a bundle, if this code runs from one. */
export const bundledBuild = () =>
  typeof PREMIND_BUNDLED_BUILD === "undefined" ? undefined : PREMIND_BUNDLED_BUILD;

const readPackageVersion = (): string => {
  try {
    const metadata = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const readBuildTime = (): number => {
  if (PREMIND_BUILD_TIME > 0) return PREMIND_BUILD_TIME;
  try {
    const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (path.resolve(repositoryRoot) !== PACKAGE_ROOT) return 0;
    const seconds = Number(
      execFileSync("git", ["log", "-1", "--format=%ct", "HEAD"], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  }
};

let packagedBuild: DaemonBuild | undefined;

/** This package's build, read lazily so short-lived hooks pay only when asked. */
export const readPackagedBuild = (): DaemonBuild => {
  const bundled = bundledBuild();
  packagedBuild ??= bundled
    ? { version: bundled.version, buildTime: bundled.buildTime }
    : { version: readPackageVersion(), buildTime: readBuildTime() };
  return packagedBuild;
};

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type PackageMetadata = {
  version?: unknown;
};

const PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const UNKNOWN_COMMIT = "------";

const readPackageVersion = (): string => {
  try {
    const metadata = JSON.parse(
      readFileSync(PACKAGE_JSON_PATH, "utf8"),
    ) as PackageMetadata;
    return typeof metadata.version === "string" ? metadata.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const readCommitHash = (): string => {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=6", "HEAD"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{6,}$/i.test(hash) ? hash.slice(0, 6) : UNKNOWN_COMMIT;
  } catch {
    return UNKNOWN_COMMIT;
  }
};

export const formatPremindVersion = (version: string, commit: string): string =>
  `v${version} (${commit.slice(0, 6)})`;

export const PREMIND_VERSION = readPackageVersion();
export const PREMIND_COMMIT = readCommitHash();
export const PREMIND_VERSION_LABEL = formatPremindVersion(
  PREMIND_VERSION,
  PREMIND_COMMIT,
);

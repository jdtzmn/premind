import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))

/** An absolute, extracted, dependency-installed package directory. */
export const PACKAGE_ENV = "PREMIND_E2E_PACKAGE"

let packed: string | undefined

/**
 * The Premind package that hosts install, built the way npm publishes it:
 * `npm pack` (which runs prepack and builds the daemon runtime), extracted,
 * with production dependencies installed. Hosts never load the source tree.
 *
 * CI builds it once and passes it in `PREMIND_E2E_PACKAGE`. Otherwise it is
 * built once per test process and removed when the process exits.
 */
export function packedPremind(parent: NodeJS.ProcessEnv = process.env): string {
	const given = parent[PACKAGE_ENV]
	if (given) {
		if (!path.isAbsolute(given) || !existsSync(path.join(given, "package.json"))) {
			throw new Error(`${PACKAGE_ENV} must name an absolute, extracted package directory`)
		}
		return given
	}
	if (packed) return packed
	const root = mkdtempSync(path.join(realpathSync("/tmp"), "pmn-package-"))
	process.once("exit", () => rmSync(root, { recursive: true, force: true }))
	packed = buildPackage(root)
	return packed
}

/** Pack, extract and install into `destination`; returns the package directory. */
export function buildPackage(destination: string): string {
	const run = (command: string, args: string[], cwd: string) =>
		execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
	run("npm", ["pack", "--silent", "--pack-destination", destination], REPOSITORY_ROOT)
	const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"))
	if (!tarball) throw new Error("npm pack produced no tarball")
	run("tar", ["-xzf", tarball], destination)
	const directory = path.join(destination, "package")
	run("npm", ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], directory)
	return directory
}

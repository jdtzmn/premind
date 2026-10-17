// Preloaded by the test scripts in package.json (`--import`) so no test reads or
// writes the developer's real Premind state, log, or daemon socket. Test daemons
// once wrote "listening" lines into the real daemon.log.
//
// Each test process gets its own scratch directory, removed when it exits. A
// state directory set explicitly by the caller is left alone.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

if (process.env.PREMIND_STATE_DIR === undefined) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "premind-test-state-"))
	process.env.PREMIND_STATE_DIR = path.join(root, "state")
	process.env.PREMIND_SOCKET_PATH ??= path.join(root, "premind.sock")
	process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))
}

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"

/** Disposable POSIX environment shared by every native host driver. */
export function createNativeSandbox(parent: NodeJS.ProcessEnv = process.env) {
	// /tmp stays short on macOS even when TMPDIR is a long per-user directory.
	const root = mkdtempSync(path.join(realpathSync("/tmp"), "pmn-native-"))
	const home = path.join(root, "home")
	const workspace = path.join(root, "workspace")
	const state = path.join(root, "state")
	const artifacts = path.join(root, "artifacts")
	const socket = path.join(root, "daemon.sock")
	const temporary = path.join(root, "tmp")
	try {
		for (const directory of [home, workspace, state, artifacts, temporary]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 })
		}
	} catch (error) {
		rmSync(root, { recursive: true, force: true })
		throw error
	}

	// An allowlist, not {...process.env, overrides}: no credentials, NODE_OPTIONS,
	// personal agent configuration, provider proxies, or inherited daemon paths.
	const env: NodeJS.ProcessEnv = {
		PATH: parent.PATH,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
		CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
		CODEX_HOME: path.join(home, ".codex"),
		PREMIND_STATE_DIR: state,
		PREMIND_SOCKET_PATH: socket,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
	}
	return {
		root, home, workspace, state, artifacts, socket, env,
		/** Call only after every supervised process has stopped. */
		dispose: () => rmSync(root, { recursive: true, force: true }),
	}
}

export type NativeSandbox = ReturnType<typeof createNativeSandbox>

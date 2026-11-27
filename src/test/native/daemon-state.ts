import { existsSync } from "node:fs"
import path from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

export type DaemonSession = {
	session_id: string
	host: string
	status: string
	busy_state: string
	client_id: string | null
	is_primary: number
}

/**
 * Read-only view of the daemon's database. Each query opens its own short
 * connection so reads never hold a lock the daemon needs. Queries return
 * undefined until the daemon has created its socket and database.
 */
export function daemonState(stateDir: string, socketPath: string) {
	const databasePath = path.join(stateDir, "epochs", "1", "premind.db")
	const ready = () => existsSync(socketPath) && existsSync(databasePath)
	const open = () => {
		const database = new DatabaseSync(databasePath, { readOnly: true })
		database.exec("PRAGMA busy_timeout = 250")
		return database
	}
	const tableExists = (database: DatabaseSync, name: string) =>
		database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined

	const all = <Row>(sql: string, ...params: SQLInputValue[]): Row[] | undefined => {
		if (!ready()) return undefined
		const database = open()
		try {
			// A fresh daemon creates its schema shortly after listening.
			if (!tableExists(database, "sessions")) return undefined
			return database.prepare(sql).all(...params) as Row[]
		} finally {
			database.close()
		}
	}
	const get = <Row>(sql: string, ...params: SQLInputValue[]): Row | undefined => all<Row>(sql, ...params)?.[0]

	return {
		databasePath,
		all,
		get,
		/** Primary sessions, oldest first. */
		primarySessions: () =>
			all<DaemonSession>(
				"SELECT session_id, host, status, busy_state, client_id, is_primary FROM sessions WHERE is_primary = 1 ORDER BY created_at, session_id",
			) ?? [],
		session: (sessionId: string) =>
			get<DaemonSession>("SELECT session_id, host, status, busy_state, client_id, is_primary FROM sessions WHERE session_id = ?", sessionId),
		/** Handoff ids the host confirmed for a session, oldest first. */
		confirmedHandoffs: (sessionId: string) =>
			(all<{ handoff_id: string }>(
				"SELECT handoff_id FROM reminder_handoff_settlements WHERE session_id = ? AND settlement_state = 'confirmed' ORDER BY settled_at, handoff_id",
				sessionId,
			) ?? []).map((row) => row.handoff_id),
		hasSnapshot: (repo: string, prNumber: number) =>
			get("SELECT 1 FROM pr_snapshots WHERE repo = ? AND pr_number = ?", repo, prNumber) !== undefined,
	}
}

export type DaemonState = ReturnType<typeof daemonState>

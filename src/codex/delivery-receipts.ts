import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type CodexDeliveryReceipt,
	codexDeliveryReceiptSchema,
} from "./schemas.ts";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_RETRY_MS = 20;

type LockOwner = {
	pid: number;
	token: string;
	createdAt: number;
};

export type SessionLifecycleLock = {
	listReceipts(): CodexDeliveryReceipt[];
	compareAndDeleteReceipt(receipt: CodexDeliveryReceipt): boolean;
	publishReceipt(receipt: CodexDeliveryReceipt): void;
	release(): void;
};

export type SessionLifecycleLockOptions = {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
};

const delay = async (milliseconds: number) => {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const defaultIsProcessAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const encodeSessionId = (sessionId: string) =>
	Buffer.from(sessionId, "utf8").toString("base64url");

const receiptFileName = (handoffId: string) => `${handoffId}.json`;

const lockOwner = (
	database: DatabaseSync,
	sessionId: string,
): LockOwner | undefined =>
	database
		.prepare(
			`SELECT pid, token, created_at AS createdAt
       FROM codex_lifecycle_locks
       WHERE session_id = ?`,
		)
		.get(sessionId) as LockOwner | undefined;

const ownsLock = (database: DatabaseSync, sessionId: string, token: string) =>
	lockOwner(database, sessionId)?.token === token;

export const acquireSessionLifecycleLock = async (
	pluginData: string,
	sessionId: string,
	options: SessionLifecycleLockOptions = {},
): Promise<SessionLifecycleLock> => {
	const now = options.now ?? Date.now;
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	const stateDirectory = path.join(pluginData, "premind", "v1");
	const sessionDirectory = path.join(
		stateDirectory,
		"sessions",
		encodeSessionId(sessionId),
	);
	const receiptsDirectory = path.join(sessionDirectory, "receipts");
	fs.mkdirSync(receiptsDirectory, { recursive: true });

	const databasePath = path.join(
		stateDirectory,
		"codex-lifecycle-locks.sqlite",
	);
	const database = new DatabaseSync(databasePath);
	fs.chmodSync(databasePath, 0o600);
	database.exec("PRAGMA busy_timeout = 50");
	database.exec(`
    CREATE TABLE IF NOT EXISTS codex_lifecycle_locks (
      session_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      pid INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

	const token = randomUUID();
	const deadline = now() + timeoutMs;
	let acquired = false;
	try {
		while (!acquired) {
			const createdAt = now();
			const inserted = database
				.prepare(
					`INSERT INTO codex_lifecycle_locks (session_id, token, pid, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO NOTHING`,
				)
				.run(sessionId, token, process.pid, createdAt);
			if (Number(inserted.changes) === 1) {
				acquired = true;
				break;
			}

			const owner = lockOwner(database, sessionId);
			const reclaimable =
				owner !== undefined &&
				createdAt - owner.createdAt >= staleMs &&
				!isProcessAlive(owner.pid);
			if (reclaimable) {
				const reclaimed = database
					.prepare(
						`UPDATE codex_lifecycle_locks
             SET token = ?, pid = ?, created_at = ?
             WHERE session_id = ? AND token = ?`,
					)
					.run(token, process.pid, createdAt, sessionId, owner.token);
				if (Number(reclaimed.changes) === 1) {
					acquired = true;
					break;
				}
			}

			if (now() >= deadline) {
				throw new Error(
					`Timed out acquiring Codex lifecycle lock for ${sessionId}`,
				);
			}
			await delay(retryMs);
		}
	} catch (error) {
		database.close();
		throw error;
	}

	let released = false;
	const release = () => {
		if (released) return;
		try {
			database
				.prepare(
					`DELETE FROM codex_lifecycle_locks
           WHERE session_id = ? AND token = ?`,
				)
				.run(sessionId, token);
		} finally {
			released = true;
			database.close();
		}
	};

	return {
		listReceipts() {
			const receipts: CodexDeliveryReceipt[] = [];
			for (const fileName of fs.readdirSync(receiptsDirectory).sort()) {
				if (!fileName.endsWith(".json")) continue;
				try {
					const receipt = codexDeliveryReceiptSchema.parse(
						JSON.parse(
							fs.readFileSync(path.join(receiptsDirectory, fileName), "utf8"),
						),
					);
					if (receipt.sessionId === sessionId) receipts.push(receipt);
				} catch {
					// Corrupt evidence cannot safely confirm a daemon claim. Its lease
					// remains authoritative and will expire to a retryable state.
				}
			}
			return receipts;
		},
		compareAndDeleteReceipt(receipt) {
			const receiptPath = path.join(
				receiptsDirectory,
				receiptFileName(receipt.handoffId),
			);
			try {
				const current = codexDeliveryReceiptSchema.parse(
					JSON.parse(fs.readFileSync(receiptPath, "utf8")),
				);
				if (
					current.sessionId !== sessionId ||
					current.sessionId !== receipt.sessionId ||
					current.batchId !== receipt.batchId ||
					current.handoffId !== receipt.handoffId
				) {
					return false;
				}
				fs.unlinkSync(receiptPath);
				return true;
			} catch {
				return false;
			}
		},
		publishReceipt(receipt) {
			if (released) throw new Error("Codex lifecycle lock is already released");
			const parsed = codexDeliveryReceiptSchema.parse(receipt);
			if (parsed.sessionId !== sessionId) {
				throw new Error(
					"Codex receipt session does not own this lifecycle lock",
				);
			}
			const receiptPath = path.join(
				receiptsDirectory,
				receiptFileName(parsed.handoffId),
			);
			const temporaryPath = `${receiptPath}.${token}.tmp`;
			let transactionOpen = false;
			let lockReleased = false;
			try {
				database.exec("BEGIN IMMEDIATE");
				transactionOpen = true;
				if (!ownsLock(database, sessionId, token)) {
					throw new Error(
						"Codex lifecycle lock ownership changed before receipt publication",
					);
				}
				const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
				try {
					fs.writeFileSync(descriptor, `${JSON.stringify(parsed)}\n`, "utf8");
					fs.fsyncSync(descriptor);
				} finally {
					fs.closeSync(descriptor);
				}
				const deleted = database
					.prepare(
						`DELETE FROM codex_lifecycle_locks
             WHERE session_id = ? AND token = ?`,
					)
					.run(sessionId, token);
				if (Number(deleted.changes) !== 1) {
					throw new Error(
						"Codex lifecycle lock ownership changed during receipt publication",
					);
				}
				database.exec("COMMIT");
				transactionOpen = false;
				lockReleased = true;
				released = true;
				database.close();
				fs.renameSync(temporaryPath, receiptPath);
			} catch (error) {
				if (transactionOpen) {
					try {
						database.exec("ROLLBACK");
					} catch {
						// The original publication failure remains the actionable error.
					}
				}
				if (!lockReleased) {
					try {
						fs.rmSync(temporaryPath, { force: true });
					} catch {
						// Lease expiry remains the retry path if temporary cleanup fails.
					}
				}
				throw error;
			}
		},
		release,
	};
};

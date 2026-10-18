import { randomUUID } from "node:crypto"
import type { NativeProcess } from "./process.ts"

type Record = { type: string; [key: string]: unknown }
const limit = 262_144

/** LF-only protocol reader for supervised hosts; never reuses an old event. */
export function nativeJsonl(process: NativeProcess) {
	const listeners = new Set<(record?: Record, error?: Error) => void>()
	let buffer = ""
	let failure: Error | undefined
	let pending = 0
	const fail = (error: Error) => {
		failure ??= error
		for (const listener of listeners) listener(undefined, failure)
	}
	process.child.stdin.on("error", () => fail(new Error("Native host stdin failed")))
	// A leader's exit can precede the final stdout data. Drain the pipe before
	// rejecting outstanding requests; spawn errors have no output to drain.
	process.exited.then((exit) => { if (exit.error) fail(new Error("Native host exited")) })
	process.child.stdout.once("end", () => fail(new Error(buffer ? "Truncated native JSONL record" : "Native host exited")))
	process.child.stdout.on("data", (chunk: string) => {
		if (failure) return
		buffer += chunk
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n")
			if (index > limit) return fail(new Error("Native JSONL record exceeds limit"))
			const line = buffer.slice(0, index).replace(/\r$/, "")
			buffer = buffer.slice(index + 1)
			let record: Record
			try {
				record = JSON.parse(line)
				if (!record || typeof record !== "object" || typeof record.type !== "string") throw new Error()
			} catch { return fail(new Error("Invalid native JSONL record")) }
			for (const listener of listeners) listener(record)
		}
		if (buffer.length > limit) fail(new Error("Native JSONL record exceeds limit"))
	})
	function waitFor(predicate: (record: Record) => boolean, timeoutMs = 10_000) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid JSONL deadline")
		return new Promise<Record>((resolve, reject) => {
			const finish = (record?: Record, error?: Error) => {
				clearTimeout(timer)
				listeners.delete(check)
				if (error) reject(error)
				else resolve(record!)
			}
			const check = (record?: Record, error?: Error) => {
				if (error) return finish(undefined, error)
				try { if (record && predicate(record)) finish(record) }
				catch (error) { finish(undefined, error instanceof Error ? error : new Error("Native event predicate failed")) }
			}
			const timer = setTimeout(() => finish(undefined, new Error("Native JSONL wait timed out")), timeoutMs)
			listeners.add(check)
			if (failure) finish(undefined, failure)
		})
	}
	return {
		waitFor,
		async request(command: { type: string; [key: string]: unknown }, timeoutMs = 10_000) {
			if (failure) throw failure
			if (pending >= 32) throw new Error("Native RPC request limit exceeded")
			const id = randomUUID()
			// Validate before creating a waiter: invalid local input cannot leak a timer.
			const frame = `${JSON.stringify({ ...command, id })}\n`
			if (frame.length > limit) throw new Error("Native RPC command exceeds limit")
			const response = waitFor((record) => record.type === "response" && record.id === id, timeoutMs)
			pending++
			try {
				const sent = new Promise<void>((resolve, reject) => {
					process.child.stdin.write(frame, (error) => error ? reject(error) : resolve())
				})
				const [result] = await Promise.all([response, sent])
				if (result.success !== true) throw new Error(`Native RPC command failed: ${command.type}`)
				return result.data
			} finally { pending-- }
		},
	}
}

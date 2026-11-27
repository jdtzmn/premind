import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: string }
type Stream = "stdout" | "stderr"

/** Supervise a real POSIX process group without a shell or inherited environment. */
export function startNativeProcess(options: {
	label: string
	command: string
	args?: string[]
	cwd: string
	env: NodeJS.ProcessEnv
	outputLimit?: number
}) {
	const limit = options.outputLimit ?? 16_384
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid output limit")
	const child = spawn(options.command, options.args ?? [], {
		cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
	})
	const output: Record<Stream, string> = { stdout: "", stderr: "" }
	const listeners = new Set<() => void>()
	let terminal: Exit | undefined
	let resolveExit: (value: Exit) => void
	const exited = new Promise<Exit>((resolve) => { resolveExit = resolve })
	const finish = (result: Exit) => {
		if (terminal) return
		terminal = result
		resolveExit(result)
		for (const listener of listeners) listener()
	}
	child.once("error", (error) => finish({ code: null, signal: null, error: error.message }))
	child.once("exit", (code, signal) => finish({ code, signal }))
	for (const stream of ["stdout", "stderr"] as const) {
		child[stream].setEncoding("utf8")
		child[stream].on("data", (chunk: string) => {
			output[stream] = (output[stream] + chunk).slice(-limit)
			for (const listener of listeners) listener()
		})
	}

	function waitForOutput(marker: string, timeoutMs: number, stream: Stream = "stdout") {
		if (!marker || marker.length > limit) throw new Error("Invalid output marker")
		validateDeadline(timeoutMs)
		return new Promise<void>((resolve, reject) => {
			const done = (error?: Error) => {
				clearTimeout(timer)
				listeners.delete(check)
				if (error) reject(error)
				else resolve()
			}
			const check = () => {
				if (output[stream].includes(marker)) done()
				else if (terminal) done(new Error(`${options.label} exited before readiness: ${JSON.stringify(terminal)}`))
			}
			const timer = setTimeout(() => done(new Error(`${options.label} readiness timed out after ${timeoutMs}ms`)), timeoutMs)
			listeners.add(check)
			check()
		})
	}

	let stopping: Promise<void> | undefined
	function stop(graceMs = 250): Promise<void> {
		validateDeadline(graceMs)
		return stopping ??= (async () => {
			const signalGroup = (signal: NodeJS.Signals) => {
				if (!child.pid) return
				try { process.kill(-child.pid, signal) }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
			}
			try {
				signalGroup("SIGTERM")
				await Promise.race([exited, delay(graceMs)])
				// The leader may have exited while descendants still own the pipes.
				signalGroup("SIGKILL")
				let timer: ReturnType<typeof setTimeout> | undefined
				try {
					await Promise.race([
						exited,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error(`${options.label} did not exit after SIGKILL`)), 2_000)
						}),
					])
				} finally { clearTimeout(timer) }
			} finally {
				child.stdin.destroy()
				child.stdout.destroy()
				child.stderr.destroy()
			}
		})()
	}
	return { child, exited, output, waitForOutput, stop }
}

function validateDeadline(milliseconds: number) {
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("Invalid deadline")
}

export type NativeProcess = ReturnType<typeof startNativeProcess>

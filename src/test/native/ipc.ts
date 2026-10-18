import net from "node:net"

/** One real newline-framed IPC exchange; the deadline bounds the entire operation. */
export function nativeIpcRequest(socketPath: string, request: unknown, timeoutMs = 2_000): Promise<unknown> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid IPC deadline")
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath)
		let buffer = ""
		const finish = (error?: Error, value?: unknown) => {
			clearTimeout(timer)
			socket.destroy()
			if (error) reject(error)
			else resolve(value)
		}
		const timer = setTimeout(() => finish(new Error(`Native IPC deadline exceeded after ${timeoutMs}ms`)), timeoutMs)
		socket.setEncoding("utf8")
		socket.once("error", (error) => finish(error))
		socket.once("end", () => finish(new Error("Native IPC closed before a complete response")))
		socket.once("connect", () => {
			try { socket.write(`${JSON.stringify(request)}\n`) }
			catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
		})
		socket.on("data", (chunk) => {
			buffer += chunk
			if (buffer.length > 1_048_576) {
				finish(new Error("Native IPC response exceeds 1MiB limit"))
				return
			}
			const newline = buffer.indexOf("\n")
			if (newline < 0) return
			try { finish(undefined, JSON.parse(buffer.slice(0, newline))) }
			catch { finish(new Error("Native IPC returned invalid JSON")) }
		})
	})
}

// Stand-in for a Premind daemon that predates bootstrap and requestHandover
// (#79 to #82): it holds the daemon lock, answers status probes over protocol
// v1, rejects `initialize`, and shuts down gracefully on SIGTERM.
// Usage: node premind-daemon.mjs <socketPath> <daemonLockPath>
import fs from "node:fs"
import net from "node:net"

const [socketPath, lockPath] = process.argv.slice(2)
fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}:legacy-token`)
const server = net.createServer((socket) =>
	socket.once("data", (chunk) => {
		const request = JSON.parse(String(chunk))
		const response =
			request.type === "initialize"
				? { ok: false, protocolVersion: 1, error: { code: "BAD_REQUEST", message: "unsupported request type" } }
				: { ok: true, protocolVersion: 1, result: { daemon: { protocolVersion: 1, operations: [] } } }
		socket.end(`${JSON.stringify(response)}\n`)
	}),
)
server.listen(socketPath, () => process.stdout.write("ready\n"))
process.on("SIGTERM", () =>
	server.close(() => {
		fs.rmSync(lockPath, { force: true })
		process.exit(0)
	}),
)

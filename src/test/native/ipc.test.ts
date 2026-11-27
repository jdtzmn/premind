import assert from "node:assert/strict"
import net from "node:net"
import { test, type TestContext } from "node:test"
import { nativeIpcRequest } from "./ipc.ts"
import { createNativeSandbox } from "./sandbox.ts"

async function fixture(t: TestContext, handler: (socket: net.Socket) => void) {
	const sandbox = createNativeSandbox()
	const sockets = new Set<net.Socket>()
	const server = net.createServer((socket) => {
		sockets.add(socket)
		socket.on("error", () => {})
		socket.once("close", () => sockets.delete(socket))
		handler(socket)
	})
	t.after(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>((resolve) => server.close(() => resolve()))
		sandbox.dispose()
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(sandbox.socket, resolve)
	})
	return sandbox.socket
}

test("native IPC exchanges real newline-framed JSON across a Unix socket", async (t) => {
	const socket = await fixture(t, (connection) => {
		connection.once("data", (request) => {
			assert.deepEqual(JSON.parse(request.toString()), { type: "fixture" })
			connection.write('{"ok":')
			connection.end("true}\n")
		})
	})
	assert.deepEqual(await nativeIpcRequest(socket, { type: "fixture" }), { ok: true })
})

test("native IPC fails on early EOF and malformed JSON", async (t) => {
	const empty = await fixture(t, (connection) => connection.end())
	await assert.rejects(nativeIpcRequest(empty, {}), /closed before a complete response/)
	const malformed = await fixture(t, (connection) => connection.end("not-json\n"))
	await assert.rejects(nativeIpcRequest(malformed, {}), /invalid JSON/)
})

test("native IPC bounds a peer that never responds", async (t) => {
	const socket = await fixture(t, () => {})
	await assert.rejects(nativeIpcRequest(socket, {}, 20), /deadline exceeded/)
	assert.throws(() => nativeIpcRequest(socket, {}, 0), /Invalid IPC deadline/)
})

test("native IPC rejects oversized responses", async (t) => {
	const socket = await fixture(t, (connection) => connection.end("x".repeat(1_048_577)))
	await assert.rejects(nativeIpcRequest(socket, {}), /exceeds 1MiB/)
})

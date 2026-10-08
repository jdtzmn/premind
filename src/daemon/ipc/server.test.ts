import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StateStore } from "../persistence/store.ts";
import { IpcServer } from "./server.ts";

const createServer = (dir: string) =>
	new IpcServer(new StateStore(path.join(dir, "premind.db")));

test("closing leaves a socket that another daemon has since bound", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-ipc-server-"));
	const socketPath = path.join(dir, "premind.sock");
	const orphan = createServer(dir);
	await orphan.listen(socketPath);

	// Another daemon replaced the socket file, stranding the first one.
	fs.rmSync(socketPath);
	const owner = net.createServer();
	await new Promise<void>((resolve) => owner.listen(socketPath, resolve));
	try {
		await orphan.close(socketPath);
		assert.equal(fs.existsSync(socketPath), true);
	} finally {
		await new Promise<void>((resolve) => owner.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("closing removes the daemon's own socket", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-ipc-server-"));
	const socketPath = path.join(dir, "premind.sock");
	const server = createServer(dir);
	try {
		await server.listen(socketPath);
		await server.close(socketPath);
		assert.equal(fs.existsSync(socketPath), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

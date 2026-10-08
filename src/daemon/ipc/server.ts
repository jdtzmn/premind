import net from "node:net";
import fs from "node:fs";
import { createLogger } from "../logging/logger.ts";
import { requestSchema } from "../../shared/ipc.ts";
import type { PremindResponse } from "../../shared/ipc.ts";
import { PREMIND_SOCKET_PATH } from "../../shared/constants.ts";
import { isSocketReachable } from "../../shared/daemon-startup.ts";
import { Router } from "./router.ts";
import { StateStore } from "../persistence/store.ts";
import { ReminderHandoffRegistry } from "../reminders/reminder-handoff-registry.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";

const SOCKET_TAKEOVER_PROBE_MS = 2_000;

const socketInode = (socketPath: string): number | undefined => {
	try {
		return fs.statSync(socketPath).ino;
	} catch {
		return undefined;
	}
};

export class IpcServer {
	private readonly logger = createLogger("daemon.ipc");
	readonly store: StateStore;
	readonly worktreeBindings: WorktreeBindingRegistry;
	readonly reminderHandoffs: ReminderHandoffRegistry;
	private readonly router: Router;
	private demandChangeListener: () => void = () => {};
	private socketInode: number | undefined;
	private readonly server = net.createServer((socket) => {
		let buffer = "";

		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line.length > 0) {
					void this.handleLine(line).then((response) => {
						socket.write(`${JSON.stringify(response)}\n`);
					});
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});
	});

	constructor(
		store = new StateStore(),
		worktreeBindings = new WorktreeBindingRegistry(store),
		reminderHandoffs = new ReminderHandoffRegistry(store),
	) {
		this.store = store;
		this.worktreeBindings = worktreeBindings;
		this.reminderHandoffs = reminderHandoffs;
		this.router = new Router(
			store,
			undefined,
			worktreeBindings,
			reminderHandoffs,
			() => this.demandChangeListener(),
		);
	}

	async listen(socketPath = PREMIND_SOCKET_PATH) {
		if (fs.existsSync(socketPath)) {
			// A busy daemon can take well over the default probe to accept a
			// connection. Deleting its socket would strand it, so probe patiently.
			if (await isSocketReachable(socketPath, SOCKET_TAKEOVER_PROBE_MS)) {
				throw new Error(`premind daemon already owns socket: ${socketPath}`);
			}
			fs.rmSync(socketPath);
		}
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(socketPath, () => resolve());
		});
		this.socketInode = socketInode(socketPath);
		this.logger.info("listening", { socketPath });
	}

	async close(socketPath = PREMIND_SOCKET_PATH) {
		// Closing a listening Unix socket also unlinks its path. If another daemon
		// has since bound that path, closing would cut it off, so only stop
		// holding the process open and let the handle die with this process.
		const ownsSocket =
			this.socketInode !== undefined &&
			socketInode(socketPath) === this.socketInode;
		if (ownsSocket || this.socketInode === undefined) {
			await new Promise<void>((resolve, reject) => {
				this.server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
			if (fs.existsSync(socketPath) && ownsSocket) fs.rmSync(socketPath);
		} else {
			this.server.unref();
		}
		this.reminderHandoffs.close();
		this.worktreeBindings.close();
		this.store.close();
	}

	setDemandChangeListener(listener: () => void) {
		this.demandChangeListener = listener;
	}

	hasDemand(now = Date.now()) {
		return this.router.hasDaemonDemand(now);
	}

	shouldShutdown(now = Date.now()) {
		return !this.hasDemand(now);
	}
	private async handleLine(line: string): Promise<PremindResponse> {
		try {
			const request = requestSchema.parse(JSON.parse(line));
			return await this.router.handle(request);
		} catch (error) {
			this.logger.warn("failed to handle request", {
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				ok: false,
				protocolVersion: 1,
				error: {
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Invalid request",
				},
			};
		}
	}
}

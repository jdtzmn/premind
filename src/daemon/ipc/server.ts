import net from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createLogger } from "../logging/logger.ts";
import { legacyRequestSchema } from "../../shared/ipc.ts";
import type { PremindResponse } from "../../shared/ipc.ts";
import { PREMIND_SOCKET_PATH } from "../../shared/constants.ts";
import {
  bootstrapInitializeRequestSchema,
  bootstrapResponseSchema,
  type BootstrapResponse,
} from "../../shared/protocol/bootstrap.ts";
import {
  PROTOCOL_V2,
  parseProtocolV2RequestForRouter,
  protocolV2ResponseSchema,
  toProtocolV2Response,
  type ProtocolV2Response,
} from "../../shared/protocol/v2.ts";
import { PREMIND_COMMIT, PREMIND_VERSION } from "../../shared/version.ts";
import { isSocketReachable } from "../../shared/daemon-startup.ts";
import { Router } from "./router.ts";
import { StateStore } from "../persistence/store.ts";
import { ReminderHandoffRegistry } from "../reminders/reminder-handoff-registry.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";

const SUPPORTED_PROTOCOLS = { min: 1, max: PROTOCOL_V2 } as const;

const SUPPORTED_OPERATIONS = [
  "registerClient",
  "heartbeatClient",
  "releaseClient",
  "claimSessionLease",
  "renewSessionLease",
  "transferSessionLease",
  "releaseSessionLease",
  "registerSession",
  "ensureSessionControl",
  "registerClaudeSession",
  "touchClaudeSession",
  "claimClaudeReminder",
  "confirmClaudeHandoff",
  "suspendClaudeSession",
  "updateSessionState",
  "unregisterSession",
  "deleteSession",
  "pauseSession",
  "resumeSession",
  "activateWorktree",
  "subscribe",
  "unsubscribe",
  "claimReminderBundle",
  "ackReminderBundle",
  "getPendingReminder",
  "ackReminder",
  "setGlobalDisabled",
  "getGlobalDisabled",
  "debugStatus",
  "pruneClosedSessions",
] as const;

export class IpcServer {
	private readonly logger = createLogger("daemon.ipc");
	private readonly instanceId = randomUUID();
	private socketPath = PREMIND_SOCKET_PATH;
	private lifecycleState = "starting";
	readonly store: StateStore;
	readonly worktreeBindings: WorktreeBindingRegistry;
	readonly reminderHandoffs: ReminderHandoffRegistry;
	private readonly router: Router;
	private demandChangeListener: () => void = () => {};
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

  get daemonInstanceId() {
    return this.instanceId;
  }

	async listen(socketPath = PREMIND_SOCKET_PATH) {
		this.socketPath = socketPath;
		this.lifecycleState = "starting";
		if (fs.existsSync(socketPath)) {
			if (await isSocketReachable(socketPath)) {
				throw new Error(`premind daemon already owns socket: ${socketPath}`);
			}
			fs.rmSync(socketPath);
		}
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(socketPath, () => resolve());
		});
		this.lifecycleState = "ready";
		this.logger.info("listening", { socketPath });
	}

	async close(socketPath = PREMIND_SOCKET_PATH) {
		this.lifecycleState = "draining";
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error) reject(error);
				else resolve();
			});
		});
		if (fs.existsSync(socketPath)) fs.rmSync(socketPath);
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
	private async handleLine(
		line: string,
	): Promise<PremindResponse | ProtocolV2Response | BootstrapResponse> {
		let value: unknown;
		try {
			value = JSON.parse(line);
			if (this.isRecord(value) && value.type === "initialize") {
				return this.handleInitialize(value);
			}
			if (this.isRecord(value) && value.protocolVersion === PROTOCOL_V2) {
				const request = parseProtocolV2RequestForRouter(value);
				return toProtocolV2Response(await this.router.handle(request), request);
			}
			const request = legacyRequestSchema.parse(value);
			return await this.router.handle(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid request";
			this.logger.warn("failed to handle request", { error: message });
			if (this.isRecord(value) && value.type === "initialize") {
				return bootstrapResponseSchema.parse({
					ok: false,
					bootstrapVersion: 1,
					error: { code: "CLIENT_UPGRADE_REQUIRED", message },
				});
			}
			if (this.isRecord(value) && value.protocolVersion === PROTOCOL_V2) {
				return protocolV2ResponseSchema.parse({
					ok: false,
					protocolVersion: PROTOCOL_V2,
					error: { code: "BAD_REQUEST", message },
				});
			}
			return {
				ok: false,
				protocolVersion: 1,
				error: { code: "BAD_REQUEST", message },
			};
		}
	}

	private handleInitialize(value: unknown): BootstrapResponse {
		const request = bootstrapInitializeRequestSchema.parse(value);
		const selected = Math.min(request.payload.protocols.max, SUPPORTED_PROTOCOLS.max);
		if (selected < Math.max(request.payload.protocols.min, SUPPORTED_PROTOCOLS.min)) {
			return bootstrapResponseSchema.parse({
				ok: false,
				bootstrapVersion: 1,
				error: {
					code: "PROTOCOL_UNSUPPORTED",
					message: "Update the premind plugin to continue",
					supported: SUPPORTED_PROTOCOLS,
				},
			});
		}

		return bootstrapResponseSchema.parse({
			ok: true,
			bootstrapVersion: 1,
			result: {
				daemon: {
					instanceId: this.instanceId,
					pid: process.pid,
					version: PREMIND_VERSION,
					commit: PREMIND_COMMIT,
					socketPath: this.socketPath,
					lifecycleState: this.lifecycleState,
				},
				protocols: { ...SUPPORTED_PROTOCOLS, selected },
				capabilities: {
					operations: [...SUPPORTED_OPERATIONS],
					rollingSessions: false,
				},
				storage: {
					epoch: 1,
					capabilities: ["legacy-singleton-v1"],
				},
			},
		});
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}
}

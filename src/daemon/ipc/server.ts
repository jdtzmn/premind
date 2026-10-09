import net from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createLogger } from "../logging/logger.ts";
import { legacyRequestSchema } from "../../shared/ipc.ts";
import type { PremindResponse, RoutedPremindRequest } from "../../shared/ipc.ts";
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
import type { InstanceDescriptorV1 } from "../../shared/protocol/descriptor.ts";
import { PREMIND_COMMIT, PREMIND_VERSION } from "../../shared/version.ts";
import {
  isSocketReachable,
  SOCKET_TAKEOVER_PROBE_MS,
} from "../../shared/daemon-startup.ts";
import { Router } from "./router.ts";
import { StateStore } from "../persistence/store.ts";
import { ReminderHandoffRegistry } from "../reminders/reminder-handoff-registry.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";

const SUPPORTED_PROTOCOLS = { min: 1, max: PROTOCOL_V2 } as const;
const STORAGE_CAPABILITIES = {
  epoch: 1,
  capabilities: ["legacy-singleton-v1"],
};

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
  "registerCodexSession",
  "claimReminder",
  "settleReminderClaim",
  "releaseSessionOwner",
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


const socketInode = (socketPath: string): number | undefined => {
	try {
		return fs.statSync(socketPath).ino;
	} catch {
		return undefined;
	}
};

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

  get daemonInstanceId() {
    return this.instanceId;
  }

  handleRequest(request: RoutedPremindRequest) {
    return this.router.handle(request);
  }

  /** Sets the socket advertised to clients before this server starts listening. */
  advertiseSocketPath(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Answers a permanent bootstrap-v1 handshake. The legacy guard calls this so
   * current clients can discover this server from the historical socket.
   */
  bootstrap(value: unknown): BootstrapResponse {
    try {
      return this.handleInitialize(value);
    } catch (error) {
      return bootstrapResponseSchema.parse({
        ok: false,
        bootstrapVersion: 1,
        error: {
          code: "CLIENT_UPGRADE_REQUIRED",
          message: error instanceof Error ? error.message : "Invalid request",
        },
      });
    }
  }

	async listen(socketPath = PREMIND_SOCKET_PATH) {
		this.socketPath = socketPath;
		this.lifecycleState = "starting";
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
		// Owner-only: another local user must not drive this daemon.
		fs.chmodSync(socketPath, 0o600);
		this.socketInode = socketInode(socketPath);
		this.lifecycleState = "ready";
		this.logger.info("listening", { socketPath });
	}

	async close(socketPath = PREMIND_SOCKET_PATH) {
		this.lifecycleState = "draining";
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
	private async handleLine(
		line: string,
	): Promise<PremindResponse | ProtocolV2Response | BootstrapResponse> {
		let value: unknown;
		try {
			value = JSON.parse(line);
			if (this.isRecord(value) && value.type === "initialize") {
				return this.bootstrap(value);
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
				daemon: this.identity(),
				protocols: { ...SUPPORTED_PROTOCOLS, selected },
				capabilities: {
					operations: [...SUPPORTED_OPERATIONS],
					rollingSessions: false,
				},
				storage: STORAGE_CAPABILITIES,
			},
		});
	}

	/** The permanent descriptor-v1 this instance publishes for discovery. */
	describe(heartbeatAt = Date.now()): InstanceDescriptorV1 {
		return {
			descriptorFormat: 1,
			...this.identity(),
			protocols: { ...SUPPORTED_PROTOCOLS },
			storage: STORAGE_CAPABILITIES,
			heartbeatAt,
		};
	}

	private identity() {
		return {
			instanceId: this.instanceId,
			pid: process.pid,
			version: PREMIND_VERSION,
			commit: PREMIND_COMMIT,
			socketPath: this.socketPath,
			lifecycleState: this.lifecycleState,
		};
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}
}

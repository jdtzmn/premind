import fs from "node:fs";
import net from "node:net";
import type { LegacyV1ProxyRouter } from "./legacy-v1-proxy.ts";
import { isSocketReachable, SOCKET_TAKEOVER_PROBE_MS } from "../daemon-startup.ts";

const socketInode = (socketPath: string): number | undefined => {
  try {
    return fs.statSync(socketPath).ino;
  } catch {
    return undefined;
  }
};

export class LegacyV1GuardServer {
  private socketPath?: string;
  private socketInode?: number;
  private readonly server: net.Server;

  constructor(
    private readonly router: LegacyV1ProxyRouter,
    // Answers bootstrap handshakes so current clients can discover the modern
    // socket; without it the guard rejects them and clients fall back to v1.
    private readonly bootstrap?: (value: unknown) => unknown,
  ) {
    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      // A client that disconnects before its reply (a liveness probe, a timed
      // out request) must not crash the daemon with an unhandled EPIPE.
      socket.on("error", () => socket.destroy());
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            void this.handleLine(line).then((response) => {
              if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
            });
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
  }

  async listen(socketPath: string): Promise<void> {
    if (await isSocketReachable(socketPath, SOCKET_TAKEOVER_PROBE_MS)) {
      throw new Error(`LEGACY_SOCKET_BUSY: ${socketPath}`);
    }
    fs.rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    // Owner-only: the historical path is predictable, so restrict who connects.
    fs.chmodSync(socketPath, 0o600);
    this.socketPath = socketPath;
    this.socketInode = socketInode(socketPath);
  }

  async close(): Promise<void> {
    // Closing a listening Unix socket unlinks its path. If another daemon has
    // since rebound the historical path, leave it alone and just let this
    // handle die with the process.
    const ownsSocket =
      this.socketPath !== undefined &&
      this.socketInode !== undefined &&
      socketInode(this.socketPath) === this.socketInode;
    if (this.socketPath === undefined || ownsSocket) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
      if (this.socketPath) fs.rmSync(this.socketPath, { force: true });
    } else {
      this.server.unref();
    }
    this.socketPath = undefined;
    this.socketInode = undefined;
  }

  private async handleLine(line: string) {
    try {
      const value: unknown = JSON.parse(line);
      if (
        this.bootstrap &&
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "initialize"
      ) {
        return this.bootstrap(value);
      }
      return await this.router.handle(value);
    } catch {
      return {
        ok: false as const,
        protocolVersion: 1,
        error: { code: "BAD_REQUEST", message: "Malformed protocol-v1 request" },
      };
    }
  }
}

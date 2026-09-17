import fs from "node:fs";
import net from "node:net";
import type { LegacyV1ProxyRouter } from "./legacy-v1-proxy.ts";
import { isSocketReachable } from "../daemon-startup.ts";

export class LegacyV1GuardServer {
  private socketPath?: string;
  private readonly server: net.Server;

  constructor(private readonly router: LegacyV1ProxyRouter) {
    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            void this.handleLine(line).then((response) => {
              socket.write(`${JSON.stringify(response)}\n`);
            });
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
  }

  async listen(socketPath: string): Promise<void> {
    if (await isSocketReachable(socketPath)) {
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
    this.socketPath = socketPath;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    if (this.socketPath) fs.rmSync(this.socketPath, { force: true });
    this.socketPath = undefined;
  }

  private async handleLine(line: string) {
    try {
      return await this.router.handle(JSON.parse(line));
    } catch {
      return {
        ok: false as const,
        protocolVersion: 1,
        error: { code: "BAD_REQUEST", message: "Malformed protocol-v1 request" },
      };
    }
  }
}

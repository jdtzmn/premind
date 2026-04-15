import net from "node:net"
import fs from "node:fs"
import { createLogger } from "../logging/logger.ts"
import { requestSchema } from "../../shared/ipc.ts"
import type { PremindResponse } from "../../shared/ipc.ts"
import { PREMIND_SOCKET_PATH } from "../../shared/constants.ts"
import { Router } from "./router.ts"
import { StateStore } from "../persistence/store.ts"

export class IpcServer {
  private readonly logger = createLogger("daemon.ipc")
  readonly store: StateStore
  private readonly router: Router
  private readonly server = net.createServer((socket) => {
    let buffer = ""

    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf("\n")
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line.length > 0) {
          const response = this.handleLine(line)
          socket.write(`${JSON.stringify(response)}\n`)
        }
        newlineIndex = buffer.indexOf("\n")
      }
    })
  })

  constructor(store = new StateStore()) {
    this.store = store
    this.router = new Router(store)
  }

  async listen(socketPath = PREMIND_SOCKET_PATH) {
    if (fs.existsSync(socketPath)) fs.rmSync(socketPath)
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(socketPath, () => resolve())
    })
    this.logger.info("listening", { socketPath })
  }

  async close(socketPath = PREMIND_SOCKET_PATH) {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    if (fs.existsSync(socketPath)) fs.rmSync(socketPath)
    this.store.close()
  }

  shouldShutdown() {
    return !this.router.hasActiveLeases() && !this.router.hasActiveSessions()
  }
  private handleLine(line: string): PremindResponse {
    try {
      const request = requestSchema.parse(JSON.parse(line))
      return this.router.handle(request)
    } catch (error) {
      this.logger.warn("failed to handle request", {
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        ok: false,
        protocolVersion: 1,
        error: { code: "BAD_REQUEST", message: "Invalid request" },
      }
    }
  }
}

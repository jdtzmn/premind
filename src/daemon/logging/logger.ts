import fs from "node:fs"
import { PREMIND_DAEMON_LOG_PATH, PREMIND_DAEMON_LOG_MAX_BYTES, PREMIND_STATE_DIR } from "../../shared/constants.ts"

type LogLevel = "debug" | "info" | "warn" | "error"

// Lazy file stream shared across all Logger instances. Opened on first write.
let logStream: fs.WriteStream | null = null

function getLogStream(): fs.WriteStream {
  if (logStream) return logStream

  // Ensure the state directory exists.
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  // Rotate if the log file is too large.
  try {
    const stat = fs.statSync(PREMIND_DAEMON_LOG_PATH)
    if (stat.size > PREMIND_DAEMON_LOG_MAX_BYTES) {
      fs.renameSync(PREMIND_DAEMON_LOG_PATH, `${PREMIND_DAEMON_LOG_PATH}.prev`)
    }
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }

  logStream = fs.createWriteStream(PREMIND_DAEMON_LOG_PATH, { flags: "a" })
  logStream.on("error", () => {
    // If we can't write the log file, silence the error — stdout/stderr still work.
    logStream = null
  })
  return logStream
}

// The daemon outlives the host that spawned it, and some hosts pipe its stdio.
// Once that host exits, writes fail with EPIPE; unhandled, that error crashed
// the daemon under every other host. Console output is best-effort; the log
// file is the durable record.
const guardedStreams = new WeakSet<NodeJS.WriteStream>()

function writeConsole(stream: NodeJS.WriteStream, text: string) {
  if (!guardedStreams.has(stream)) {
    guardedStreams.add(stream)
    stream.on("error", () => {})
  }
  if (stream.destroyed || !stream.writable) return
  try {
    stream.write(text)
  } catch {
    // A synchronous write error means the same closed stream.
  }
}

export class Logger {
  constructor(private readonly service: string) {}

  debug(message: string, extra?: Record<string, unknown>) {
    this.write("debug", message, extra)
  }

  info(message: string, extra?: Record<string, unknown>) {
    this.write("info", message, extra)
  }

  warn(message: string, extra?: Record<string, unknown>) {
    this.write("warn", message, extra)
  }

  error(message: string, extra?: Record<string, unknown>) {
    this.write("error", message, extra)
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      // Several daemons can append to one log file; the PID tells them apart.
      pid: process.pid,
      service: this.service,
      message,
      ...(extra ? { extra } : {}),
    }
    const line = JSON.stringify(entry)
    writeConsole(level === "error" ? process.stderr : process.stdout, `${line}\n`)
    try {
      getLogStream().write(`${line}\n`)
    } catch {
      // Non-fatal — console output is still available.
    }
  }
}

export const createLogger = (service: string) => new Logger(service)

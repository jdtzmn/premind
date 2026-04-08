type LogLevel = "debug" | "info" | "warn" | "error"

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
      service: this.service,
      message,
      ...(extra ? { extra } : {}),
    }
    const line = JSON.stringify(entry)
    if (level === "error") {
      process.stderr.write(`${line}\n`)
      return
    }
    process.stdout.write(`${line}\n`)
  }
}

export const createLogger = (service: string) => new Logger(service)

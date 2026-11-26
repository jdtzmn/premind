import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { readDaemonLockOwner } from "../../shared/daemon-startup.ts"
import { startFakeGitHub, type FakeGitHub } from "../harness/fake-github.ts"
import { startFakeModel, type FakeModel } from "./fake-model.ts"

/**
 * End-to-end environment for the OpenCode V2 plugin:
 *
 *   fake GitHub ─▶ real premind daemon ─▶ real `opencode serve` ─▶ fake model
 *
 * Everything runs in a scratch directory with its own HOME, XDG directories,
 * premind state directory and socket. The plugin starts the daemon itself, as
 * it does for users, and the daemon inherits the fake GitHub settings.
 *
 * The OpenCode binary comes from `PREMIND_OPENCODE_BIN`, or `opencode` on the
 * PATH. Tests call `findOpenCodeV2()` first and skip when it is missing or
 * older than V2.
 */

export const PLUGIN_SOURCE_DIR = fileURLToPath(new URL("../../plugin-opencode-v2", import.meta.url))

export const REPO = "acme/widgets"
export const BRANCH = "feature/widgets"

export type OpenCodeBinary = { bin: string; version: string }

export const findOpenCodeV2 = (): OpenCodeBinary | { missing: string } => {
  const bin = process.env.PREMIND_OPENCODE_BIN ?? "opencode"
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 })
  // Prints `opencode v2.4.2`.
  const version = (result.stdout?.trim().split(/\s+/).pop() ?? "").replace(/^v/, "")
  let missing: string | undefined
  if (result.error || result.status !== 0) missing = `${bin} is not installed`
  else if (!/^2\./.test(version)) missing = `${bin} is ${version || "unknown"}, need OpenCode 2.x`
  if (!missing) return { bin, version }
  // CI sets this so a broken install fails the job instead of skipping it.
  if (process.env.PREMIND_REQUIRE_OPENCODE === "1") throw new Error(missing)
  return { missing }
}

export type OpenCodeV2Environment = {
  root: string
  projectDir: string
  stateDir: string
  socketPath: string
  github: FakeGitHub
  model: FakeModel
  url: string
  client: OpenCodeClient
  /** Server output so far, for assertion messages. */
  logs(): string
  /** Stop and start the OpenCode server, keeping every directory. */
  restart(): Promise<void>
  close(): Promise<void>
}

export type OpenCodeV2EnvironmentOptions = {
  binary: OpenCodeBinary
  /** Plugin entry for `opencode.json`. Defaults to the plugin source directory. */
  plugin?: string
  startupTimeoutMs?: number
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Premind Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
}

const createProject = (projectDir: string, plugin: string, modelUrl: string) => {
  fs.mkdirSync(projectDir, { recursive: true })
  git(projectDir, "init", "-q", "-b", BRANCH)
  git(projectDir, "remote", "add", "origin", `https://github.com/${REPO}.git`)
  fs.writeFileSync(
    path.join(projectDir, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "fake/test",
        plugins: [plugin],
        providers: {
          fake: {
            name: "Fake",
            env: ["FAKE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: modelUrl },
            models: { test: { name: "Test" } },
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  git(projectDir, "add", ".")
  git(projectDir, "commit", "-q", "-m", "Initial commit")
}

const waitForExit = (child: ChildProcess, timeoutMs: number) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const startOpenCodeV2Environment = async (options: OpenCodeV2EnvironmentOptions): Promise<OpenCodeV2Environment> => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "premind-opencode-v2-")))
  const home = path.join(root, "home")
  const projectDir = path.join(root, "project")
  const stateDir = path.join(root, "state")
  const socketPath = path.join(root, "premind.sock")
  fs.mkdirSync(home, { recursive: true })

  const github = await startFakeGitHub()
  const model = await startFakeModel()
  createProject(projectDir, options.plugin ?? PLUGIN_SOURCE_DIR, model.url)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    FAKE_API_KEY: "test",
    PREMIND_STATE_DIR: stateDir,
    PREMIND_SOCKET_PATH: socketPath,
    ...github.env(),
  }

  let output = ""
  let child: ChildProcess | undefined
  let url = ""
  let client: OpenCodeClient | undefined

  const start = async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    const server = spawn(options.binary.bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child = server
    const password = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`opencode serve did not start:\n${output.slice(-4000)}`)),
        options.startupTimeoutMs ?? 30_000,
      )
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const match = /server password (\S+)/.exec(output.slice(-8000))
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      server.stdout?.on("data", onData)
      server.stderr?.on("data", onData)
      server.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`opencode serve exited with ${code}:\n${output.slice(-4000)}`))
      })
    })
    client = OpenCode.make({
      baseUrl: url,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "x-opencode-directory": projectDir,
      },
    })
    // The server prints its password before it accepts requests.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.plugin.list()
        return
      } catch (error) {
        if (attempt >= 50) throw error
        await sleep(200)
      }
    }
  }

  const stop = async () => {
    if (!child) return
    const current = child
    child = undefined
    current.kill("SIGTERM")
    await waitForExit(current, 10_000)
  }

  await start()

  return {
    root,
    projectDir,
    stateDir,
    socketPath,
    github,
    model,
    get url() {
      return url
    },
    get client() {
      if (!client) throw new Error("OpenCode server is not running")
      return client
    },
    logs: () => output,
    restart: async () => {
      await stop()
      await start()
    },
    close: async () => {
      await stop()
      const daemonPid = readDaemonLockOwner(stateDir)?.pid
      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM")
        } catch {}
      }
      await Promise.all([github.close(), model.close()])
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
